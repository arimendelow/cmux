import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveBaseUrl, runBossRepair } from "../boss-repair";

const scratchRoot = join(import.meta.dir, ".scratch");

interface HelloBoss {
  status: "none" | "canonical" | "blocked";
  agent: string;
  sessionId?: string;
  reason?: string;
  detail?: string;
  skipped: { id: string; agent: string; reason: string }[];
}

async function tempRoot(prefix: string): Promise<string> {
  await mkdir(scratchRoot, { recursive: true });
  return mkdtemp(join(scratchRoot, prefix));
}

async function waitForPort(stateFile: string): Promise<number> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const state = JSON.parse(await readFile(stateFile, "utf8"));
      if (Number.isInteger(state.port) && state.port > 0) return state.port;
    } catch {}
    await Bun.sleep(20);
  }
  throw new Error("timed out waiting for Agent Chat state file");
}

async function writeRecord(directory: string, id: string, cwd: string, createdAt: number) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, `${id}.json`), JSON.stringify({
    id,
    provider: "ouro-boss",
    providerSessionId: `provider-${id}`,
    cwd,
    title: "Boss",
    autoApprove: false,
    startOptions: {},
    createdAt,
  }), { mode: 0o600 });
}

async function shim(root: string): Promise<string> {
  const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  const ouro = join(bin, "ouro");
  await Bun.write(ouro, "#!/bin/sh\nexec \"$BUN_BIN\" \"$FAKE_ACP_SCRIPT\" \"$@\"\n");
  await chmod(ouro, 0o755);
  return bin;
}

interface Harness {
  port: number;
  stop(): Promise<void>;
}

async function startServer(root: string, extraEnv: Record<string, string> = {}): Promise<Harness> {
  const stateFile = join(root, `server-${crypto.randomUUID().slice(0, 8)}.json`);
  const bin = await shim(root);
  const child = Bun.spawn(["bun", "server.ts"], {
    cwd: join(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...globalThis.process.env,
      PATH: `${bin}:${globalThis.process.env.PATH ?? ""}`,
      BUN_BIN: Bun.which("bun") ?? "bun",
      FAKE_ACP_SCRIPT: join(import.meta.dir, "fake-acp.ts"),
      CMUX_AGENT_CHAT_PORT: "0",
      CMUX_AGENT_CHAT_STATE_FILE: stateFile,
      CMUX_AGENT_CHAT_TOKEN: "boss-token",
      CMUX_AGENT_CHAT_PRODUCT: "ouro-workbench-v1",
      CMUX_AGENT_CHAT_BOSS_AGENT: "slugger",
      CMUX_AGENT_CHAT_SESSION_DIR: join(root, "sessions", "slugger"),
      CMUX_AGENT_CHAT_ALLOWED_ROOTS: root,
      CMUX_AGENT_UI_CWD: join(root, "work"),
      CMUX_AGENT_MODELS_URL: "http://127.0.0.1:1",
      ...extraEnv,
    },
  });
  const port = await waitForPort(stateFile);
  return {
    port,
    async stop() {
      child.kill();
      await child.exited;
    },
  };
}

interface Client {
  hello: any;
  messages: any[];
  send(payload: unknown): void;
  waitFor<T>(name: string, predicate: () => T | false | null | undefined): Promise<T>;
  close(): void;
}

async function connect(port: number): Promise<Client> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/boss-token/ws`);
  const messages: any[] = [];
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = () => reject(new Error("WebSocket failed to open"));
  });
  socket.onmessage = (event) => messages.push(JSON.parse(String(event.data)));
  const client: Client = {
    hello: null,
    messages,
    send: (payload) => socket.send(JSON.stringify(payload)),
    waitFor: <T,>(name: string, predicate: () => T | false | null | undefined): Promise<T> =>
      new Promise((resolve, reject) => {
        const started = Date.now();
        const tick = () => {
          const value = predicate();
          if (value) return resolve(value);
          if (Date.now() - started > 15_000) return reject(new Error(`timeout waiting for ${name}`));
          setTimeout(tick, 20);
        };
        tick();
      }),
    close: () => socket.close(),
  };
  client.hello = await client.waitFor("hello", () => messages.find((message) => message.kind === "hello"));
  return client;
}

test("a single persisted Boss is adopted as canonical and every client sees the same session", async () => {
  const root = await tempRoot("boss-adopt-");
  const work = join(root, "work");
  await mkdir(work, { recursive: true });
  await writeRecord(join(root, "sessions", "slugger"), "boss-1", work, 10);
  const server = await startServer(root);
  try {
    const first = await connect(server.port);
    const boss = first.hello.boss as HelloBoss;
    expect(boss.status).toBe("canonical");
    expect(boss.sessionId).toBe("boss-1");
    expect(boss.agent).toBe("slugger");
    expect(boss.skipped).toEqual([]);

    const pointer = JSON.parse(await readFile(join(root, "sessions", "canonical-boss.json"), "utf8"));
    expect(pointer).toEqual({ version: 1, agent: "slugger", sessionId: "boss-1" });

    const second = await connect(server.port);
    expect((second.hello.boss as HelloBoss).sessionId).toBe("boss-1");

    const sessions = await (await fetch(`http://127.0.0.1:${server.port}/boss-token/api/sessions`)).json();
    expect(sessions.map((session: any) => session.id)).toEqual(["boss-1"]);
    first.close();
    second.close();
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("ambiguous persisted Boss sessions block visibly and preserve every candidate", async () => {
  const root = await tempRoot("boss-ambiguous-");
  const work = join(root, "work");
  await mkdir(work, { recursive: true });
  await writeRecord(join(root, "sessions", "slugger"), "boss-1", work, 10);
  await writeRecord(join(root, "sessions", "slugger"), "boss-2", work, 99);
  const server = await startServer(root);
  try {
    const client = await connect(server.port);
    const boss = client.hello.boss as HelloBoss;
    expect(boss.status).toBe("blocked");
    expect(boss.reason).toBe("ambiguous-candidates");
    expect(boss.detail).toBe("2 persisted Boss sessions match agent slugger: boss-1, boss-2");
    expect(boss.skipped.map((entry) => entry.id).sort()).toEqual(["boss-1", "boss-2"]);

    expect(await readdir(join(root, "sessions"))).not.toContain("canonical-boss.json");
    expect((await readdir(join(root, "sessions", "slugger"))).sort()).toEqual(["boss-1.json", "boss-2.json"]);

    const sessions = await (await fetch(`http://127.0.0.1:${server.port}/boss-token/api/sessions`)).json();
    expect(sessions).toEqual([]);

    client.send({ op: "start", requestId: "blocked-start", provider: "ouro-boss", cwd: work, prompt: "hello" });
    const error = await client.waitFor("blocked start error", () =>
      client.messages.find((message) => message.kind === "error" && message.op === "start"));
    expect(String(error.message)).toContain("ambiguous-candidates");
    client.close();
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("a missing referenced record blocks recovery instead of creating a replacement Boss", async () => {
  const root = await tempRoot("boss-missing-");
  const work = join(root, "work");
  await mkdir(work, { recursive: true });
  await mkdir(join(root, "sessions"), { recursive: true });
  await writeFile(join(root, "sessions", "canonical-boss.json"), JSON.stringify({
    version: 1,
    agent: "slugger",
    sessionId: "boss-gone",
  }), { mode: 0o600 });
  const server = await startServer(root);
  try {
    const client = await connect(server.port);
    const boss = client.hello.boss as HelloBoss;
    expect(boss.status).toBe("blocked");
    expect(boss.reason).toBe("missing-record");
    expect(boss.detail).toBe("canonical Boss session boss-gone is not in the session store");
    expect(JSON.parse(await readFile(join(root, "sessions", "canonical-boss.json"), "utf8")).sessionId)
      .toBe("boss-gone");
    client.close();
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("the server refuses a second Boss session, fork, and delete of the canonical Boss", async () => {
  const root = await tempRoot("boss-guard-");
  const work = join(root, "work");
  await mkdir(work, { recursive: true });
  await writeRecord(join(root, "sessions", "slugger"), "boss-1", work, 10);
  const server = await startServer(root);
  try {
    const client = await connect(server.port);
    expect((client.hello.boss as HelloBoss).sessionId).toBe("boss-1");

    client.send({ op: "start", requestId: "second-boss", provider: "ouro-boss", cwd: work, prompt: "hello" });
    const startError = await client.waitFor("second boss refused", () =>
      client.messages.find((message) => message.kind === "error" && message.op === "start"));
    expect(String(startError.message)).toContain("Boss already exists");

    client.send({ op: "subscribe", sessionId: "boss-1" });
    await client.waitFor("history", () => client.messages.find((message) => message.kind === "history"));

    client.send({ op: "fork", sessionId: "boss-1" });
    const forkError = await client.waitFor("fork refused", () =>
      client.messages.find((message) => message.kind === "error" && message.op === "fork"));
    expect(String(forkError.message)).toContain("cannot be forked");

    client.send({ op: "delete", sessionId: "boss-1" });
    await Bun.sleep(200);
    const sessions = await (await fetch(`http://127.0.0.1:${server.port}/boss-token/api/sessions`)).json();
    expect(sessions.map((session: any) => session.id)).toEqual(["boss-1"]);
    expect(await readdir(join(root, "sessions", "slugger"))).toEqual(["boss-1.json"]);
    client.close();
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("concurrent first-Boss starts converge on one canonical session", async () => {
  const root = await tempRoot("boss-race-");
  const work = join(root, "work");
  await mkdir(work, { recursive: true });
  const server = await startServer(root);
  try {
    const first = await connect(server.port);
    const second = await connect(server.port);
    expect((first.hello.boss as HelloBoss).status).toBe("none");

    first.send({ op: "start", requestId: "race-a", provider: "ouro-boss", cwd: work, prompt: "hello" });
    second.send({ op: "start", requestId: "race-b", provider: "ouro-boss", cwd: work, prompt: "hello" });

    const created = await first.waitFor("first created", () =>
      first.messages.find((message) => message.kind === "session-created"));
    await second.waitFor("second settled", () =>
      second.messages.find((message) =>
        (message.kind === "error" && message.op === "start")
        || message.kind === "session-created"));

    await first.waitFor("pointer written", async () => true);
    let sessions: any[] = [];
    await first.waitFor("one visible session", async () => {
      sessions = await (await fetch(`http://127.0.0.1:${server.port}/boss-token/api/sessions`)).json();
      return sessions.length === 1 ? sessions : false;
    });
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe(created.session.id);
    first.close();
    second.close();
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("the repair contract lists candidates and repoints without deleting transcripts", async () => {
  const root = await tempRoot("boss-repair-");
  const work = join(root, "work");
  await mkdir(work, { recursive: true });
  await writeRecord(join(root, "sessions", "slugger"), "boss-1", work, 10);
  await writeRecord(join(root, "sessions", "slugger"), "boss-2", work, 20);
  await mkdir(join(root, "sessions"), { recursive: true });
  await writeFile(join(root, "sessions", "canonical-boss.json"), JSON.stringify({
    version: 1,
    agent: "slugger",
    sessionId: "boss-1",
  }), { mode: 0o600 });
  const server = await startServer(root);
  try {
    const listed = await (await fetch(`http://127.0.0.1:${server.port}/boss-token/api/boss`)).json();
    expect(listed.pointer).toEqual({ version: 1, agent: "slugger", sessionId: "boss-1" });
    expect(listed.candidates.map((entry: any) => entry.id).sort()).toEqual(["boss-1", "boss-2"]);
    expect(listed.state.status).toBe("canonical");

    const repaired = await (await fetch(`http://127.0.0.1:${server.port}/boss-token/api/boss/repoint`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "slugger", sessionId: "boss-2" }),
    })).json();
    expect(repaired.ok).toBe(true);
    expect(repaired.pointer).toEqual({ version: 1, agent: "slugger", sessionId: "boss-2" });
    expect((await readdir(join(root, "sessions", "slugger"))).sort()).toEqual(["boss-1.json", "boss-2.json"]);

    const rejected = await fetch(`http://127.0.0.1:${server.port}/boss-token/api/boss/repoint`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "slugger", sessionId: "boss-9" }),
    });
    expect(rejected.status).toBe(400);
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("restarting the server keeps the same canonical Boss session", async () => {
  const root = await tempRoot("boss-restart-");
  const work = join(root, "work");
  await mkdir(work, { recursive: true });
  await writeRecord(join(root, "sessions", "slugger"), "boss-1", work, 10);
  let server = await startServer(root);
  try {
    const first = await connect(server.port);
    expect((first.hello.boss as HelloBoss).sessionId).toBe("boss-1");
    first.close();
    await server.stop();

    server = await startServer(root);
    const second = await connect(server.port);
    const boss = second.hello.boss as HelloBoss;
    expect(boss.status).toBe("canonical");
    expect(boss.sessionId).toBe("boss-1");
    second.close();
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("records from another agent partition are skipped with an exact reason", async () => {
  const root = await tempRoot("boss-partition-");
  const work = join(root, "work");
  await mkdir(work, { recursive: true });
  await writeRecord(join(root, "sessions", "slugger"), "boss-1", work, 10);
  await writeRecord(join(root, "sessions", "other"), "boss-9", work, 99);
  const server = await startServer(root);
  try {
    const client = await connect(server.port);
    const boss = client.hello.boss as HelloBoss;
    expect(boss.status).toBe("canonical");
    expect(boss.sessionId).toBe("boss-1");
    expect(boss.skipped).toEqual([{ id: "boss-9", agent: "other", reason: "agent-mismatch" }]);
    expect(await readdir(join(root, "sessions", "other"))).toEqual(["boss-9.json"]);
    client.close();
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("the repair CLI reaches the same contract and reports a rejected target", async () => {
  const root = await tempRoot("boss-repair-cli-");
  const work = join(root, "work");
  await mkdir(work, { recursive: true });
  await writeRecord(join(root, "sessions", "slugger"), "boss-1", work, 10);
  await writeRecord(join(root, "sessions", "slugger"), "boss-2", work, 20);
  await writeFile(join(root, "sessions", "canonical-boss.json"), JSON.stringify({
    version: 1,
    agent: "slugger",
    sessionId: "boss-1",
  }), { mode: 0o600 });
  const server = await startServer(root);
  try {
    const baseUrl = `http://127.0.0.1:${server.port}/boss-token`;
    const listed = await runBossRepair("list", baseUrl, { agent: "", sessionId: "" });
    expect(listed.status).toBe(200);
    expect((listed.body as any).candidates.map((entry: any) => entry.id).sort()).toEqual(["boss-1", "boss-2"]);

    const repointed = await runBossRepair("repoint", baseUrl, { agent: "slugger", sessionId: "boss-2" });
    expect(repointed.status).toBe(200);
    expect((repointed.body as any).pointer.sessionId).toBe("boss-2");

    const rejected = await runBossRepair("repoint", baseUrl, { agent: "slugger", sessionId: "boss-9" });
    expect(rejected.status).toBe(400);
    expect((rejected.body as any).error).toBe("no persisted Boss session slugger/boss-9");
    expect((await readdir(join(root, "sessions", "slugger"))).sort()).toEqual(["boss-1.json", "boss-2.json"]);

    await expect(runBossRepair("repoint", baseUrl, { agent: "", sessionId: "" }))
      .rejects.toThrow("repoint requires --agent and --session");
    await expect(runBossRepair("wat", baseUrl, { agent: "", sessionId: "" }))
      .rejects.toThrow("unknown command: wat");
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("the repair CLI resolves its base URL from an explicit URL or the sidecar state file", async () => {
  const root = await tempRoot("boss-repair-base-");
  try {
    expect(await resolveBaseUrl({ CMUX_AGENT_CHAT_BASE_URL: "http://127.0.0.1:9/" })).toBe("http://127.0.0.1:9");
    const stateFile = join(root, "state.json");
    await writeFile(stateFile, JSON.stringify({ port: 4321 }));
    expect(await resolveBaseUrl({ CMUX_AGENT_CHAT_TOKEN: "tok" }, stateFile)).toBe("http://127.0.0.1:4321/tok");
    expect(await resolveBaseUrl({}, stateFile)).toBe("http://127.0.0.1:4321");
    await expect(resolveBaseUrl({}, "")).rejects.toThrow("pass --base-url or --state-file");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("a Boss session is protected from fork and delete before its pointer lands", async () => {
  const root = await tempRoot("boss-preadopt-");
  const work = join(root, "work");
  await mkdir(work, { recursive: true });
  const server = await startServer(root);
  try {
    const client = await connect(server.port);
    expect((client.hello.boss as HelloBoss).status).toBe("none");
    client.send({ op: "start", requestId: "first", provider: "ouro-boss", cwd: work, prompt: "hello" });
    const created = await client.waitFor("created", () =>
      client.messages.find((message) => message.kind === "session-created"));

    client.send({ op: "delete", sessionId: created.session.id });
    const deleteError = await client.waitFor("delete refused", () =>
      client.messages.find((message) => message.kind === "error" && message.op === "delete"));
    expect(String(deleteError.message)).toContain("cannot be deleted");

    client.send({ op: "fork", sessionId: created.session.id });
    const forkError = await client.waitFor("fork refused", () =>
      client.messages.find((message) => message.kind === "error" && message.op === "fork"));
    expect(String(forkError.message)).toContain("cannot be forked");

    const sessions = await (await fetch(`http://127.0.0.1:${server.port}/boss-token/api/sessions`)).json();
    expect(sessions.map((session: any) => session.id)).toEqual([created.session.id]);
    client.close();
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("a replayed start request re-attaches instead of being refused as a second Boss", async () => {
  const root = await tempRoot("boss-replay-");
  const work = join(root, "work");
  await mkdir(work, { recursive: true });
  const server = await startServer(root);
  try {
    const client = await connect(server.port);
    const payload = { op: "start", requestId: "replayed", provider: "ouro-boss", cwd: work, prompt: "hello" };
    client.send(payload);
    const created = await client.waitFor("created", () =>
      client.messages.find((message) => message.kind === "session-created"));

    client.send(payload);
    const history = await client.waitFor("history replay", () =>
      client.messages.find((message) => message.kind === "history" && message.sessionId === created.session.id));
    expect(history.session.id).toBe(created.session.id);
    expect(client.messages.some((message) => message.kind === "error" && message.op === "start")).toBe(false);
    client.close();
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("repair refuses a foreign-agent target and loads the session it repoints to", async () => {
  const root = await tempRoot("boss-repair-guard-");
  const work = join(root, "work");
  await mkdir(work, { recursive: true });
  await writeRecord(join(root, "sessions", "slugger"), "boss-1", work, 10);
  await writeRecord(join(root, "sessions", "slugger"), "boss-2", work, 20);
  await writeRecord(join(root, "sessions", "other"), "boss-9", work, 30);
  await writeFile(join(root, "sessions", "canonical-boss.json"), JSON.stringify({
    version: 1,
    agent: "slugger",
    sessionId: "boss-1",
  }), { mode: 0o600 });
  const server = await startServer(root);
  try {
    const foreign = await fetch(`http://127.0.0.1:${server.port}/boss-token/api/boss/repoint`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "other", sessionId: "boss-9" }),
    });
    expect(foreign.status).toBe(400);
    expect((await foreign.json()).error).toBe("other is not the configured agent slugger");

    const repaired = await fetch(`http://127.0.0.1:${server.port}/boss-token/api/boss/repoint`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "slugger", sessionId: "boss-2" }),
    });
    expect(repaired.status).toBe(200);

    const sessions = await (await fetch(`http://127.0.0.1:${server.port}/boss-token/api/sessions`)).json();
    expect(sessions.map((session: any) => session.id).sort()).toEqual(["boss-1", "boss-2"]);
    const client = await connect(server.port);
    expect((client.hello.boss as HelloBoss).sessionId).toBe("boss-2");
    client.close();
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("a cwd-unavailable repair target reports blocked instead of a canonical Boss", async () => {
  const root = await tempRoot("boss-repair-cwd-");
  const work = join(root, "work");
  const gone = join(root, "gone");
  await mkdir(work, { recursive: true });
  await mkdir(gone, { recursive: true });
  await writeRecord(join(root, "sessions", "slugger"), "boss-1", work, 10);
  await writeRecord(join(root, "sessions", "slugger"), "boss-2", gone, 20);
  await writeFile(join(root, "sessions", "canonical-boss.json"), JSON.stringify({
    version: 1,
    agent: "slugger",
    sessionId: "boss-1",
  }), { mode: 0o600 });
  const server = await startServer(root);
  try {
    await rm(gone, { recursive: true, force: true });
    const response = await fetch(`http://127.0.0.1:${server.port}/boss-token/api/boss/repoint`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "slugger", sessionId: "boss-2" }),
    });
    expect(response.status).toBe(400);
    expect(String((await response.json()).error)).toContain("boss-2");
    expect((await readdir(join(root, "sessions", "slugger"))).sort()).toEqual(["boss-1.json", "boss-2.json"]);
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("host app continuity reaches the Boss client and the repair contract verbatim", async () => {
  const root = await tempRoot("boss-continuity-");
  const work = join(root, "work");
  await mkdir(work, { recursive: true });
  await writeRecord(join(root, "sessions", "slugger"), "boss-1", work, 10);
  const server = await startServer(root, {
    CMUX_WORKBENCH_APP_INSTANCE_ID: "6E7F1B2C-0000-4000-8000-00000000ABCD",
    CMUX_WORKBENCH_APP_STARTED_AT: "2026-09-09T18:00:00Z",
    CMUX_WORKBENCH_PREVIOUS_EXIT_CLEAN: "0",
  });
  try {
    const client = await connect(server.port);
    expect(client.hello.continuity).toEqual({
      appInstanceId: "6E7F1B2C-0000-4000-8000-00000000ABCD",
      startedAt: "2026-09-09T18:00:00Z",
      previousExitClean: false,
    });

    const listed = await (await fetch(`http://127.0.0.1:${server.port}/boss-token/api/boss`)).json();
    expect(listed.continuity.appInstanceId).toBe("6E7F1B2C-0000-4000-8000-00000000ABCD");
    expect(listed.continuity.previousExitClean).toBe(false);
    client.close();
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("a host that publishes no continuity leaves the client neutral", async () => {
  const root = await tempRoot("boss-continuity-absent-");
  const work = join(root, "work");
  await mkdir(work, { recursive: true });
  const server = await startServer(root);
  try {
    const client = await connect(server.port);
    expect(client.hello.continuity).toBeNull();
    const listed = await (await fetch(`http://127.0.0.1:${server.port}/boss-token/api/boss`)).json();
    expect(listed.continuity).toBeNull();
    client.close();
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
