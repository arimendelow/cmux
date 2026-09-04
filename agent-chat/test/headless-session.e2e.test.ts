import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function waitForPort(stateFile: string): Promise<number> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const state = JSON.parse(await readFile(stateFile, "utf8"));
      if (Number.isInteger(state.port) && state.port > 0) return state.port;
    } catch {}
    await Bun.sleep(20);
  }
  throw new Error("timed out waiting for Agent Chat state file");
}

async function waitForMessage(messages: any[], predicate: (message: any) => boolean): Promise<any> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const match = messages.find(predicate);
    if (match) return match;
    await Bun.sleep(20);
  }
  throw new Error(`timed out waiting for message: ${JSON.stringify(messages)}`);
}

async function writeFakeOuro(bin: string, extraArgs = ""): Promise<void> {
  const ouro = join(bin, "ouro");
  await Bun.write(ouro, `#!/bin/sh\nif [ -n "$FAKE_OURO_ARG_LOG" ]; then printf '%s\\n' "$*" >> "$FAKE_OURO_ARG_LOG"; fi\nexec "$BUN_BIN" "$FAKE_ACP_SCRIPT"${extraArgs ? ` ${extraArgs}` : ""}\n`);
  await chmod(ouro, 0o755);
}

test("headless Boss turns stay out of visible sessions and persistence", async () => {
  const root = await mkdtemp(join(tmpdir(), "workbench-headless-boss-"));
  const sessions = join(root, "sessions");
  const stateFile = join(root, "server.json");
  const argumentLog = join(root, "ouro-args.log");
  const bin = join(root, "bin");
  await mkdir(bin);
  await writeFakeOuro(bin);
  const process = Bun.spawn(["bun", "server.ts"], {
    cwd: join(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...globalThis.process.env,
      PATH: `${bin}:${globalThis.process.env.PATH ?? ""}`,
      BUN_BIN: Bun.which("bun") ?? "bun",
      FAKE_ACP_SCRIPT: join(import.meta.dir, "fake-acp.ts"),
      FAKE_OURO_ARG_LOG: argumentLog,
      CMUX_AGENT_CHAT_PORT: "0",
      CMUX_AGENT_CHAT_STATE_FILE: stateFile,
      CMUX_AGENT_CHAT_SESSION_DIR: sessions,
      CMUX_AGENT_CHAT_TOKEN: "headless-token",
      CMUX_AGENT_CHAT_PRODUCT: "ouro-workbench-v1",
      CMUX_AGENT_CHAT_BOSS_AGENT: "slugger",
      CMUX_AGENT_CHAT_CONTEXT_LABEL: "Desk / headless-fixture",
      CMUX_AGENT_CHAT_ALLOWED_ROOTS: root,
      CMUX_AGENT_UI_CWD: root,
      CMUX_AGENT_MODELS_URL: "http://127.0.0.1:1",
    },
  });
  let socket: WebSocket | null = null;

  try {
    const port = await waitForPort(stateFile);
    socket = new WebSocket(`ws://127.0.0.1:${port}/headless-token/ws`);
    const messages: any[] = [];
    socket.onmessage = (event) => messages.push(JSON.parse(String(event.data)));
    await new Promise<void>((resolve, reject) => {
      socket!.onopen = () => resolve();
      socket!.onerror = () => reject(new Error("WebSocket failed to open"));
    });
    await waitForMessage(messages, (message) => message.kind === "hello");
    const initial = await waitForMessage(messages, (message) => message.kind === "sessions");
    expect(initial.sessions).toEqual([]);

    socket.send(JSON.stringify({
      op: "headless-start",
      requestId: "observation-1",
      provider: "ignored-provider",
      cwd: root,
      prompt: "Return one JSON disposition.",
      autoApprove: false,
      options: {},
    }));
    const created = await waitForMessage(
      messages,
      (message) => message.kind === "session-created" && message.requestId === "observation-1",
    );
    const sessionId = created.session.id;
    await waitForMessage(
      messages,
      (message) => message.kind === "event" && message.sessionId === sessionId && message.evt?.kind === "done",
    );

    const visible = await fetch(`http://127.0.0.1:${port}/headless-token/api/sessions`).then((response) => response.json());
    expect(visible).toEqual([]);
    expect(messages.filter((message) => message.kind === "sessions").every(
      (message) => !message.sessions.some((session: any) => session.id === sessionId),
    )).toBe(true);
    expect(await readdir(sessions).catch(() => [])).toEqual([]);
    expect(await readFile(argumentLog, "utf8")).toContain("--observe-only");

    await Bun.sleep(20);
    socket.send(JSON.stringify({ op: "subscribe", sessionId }));
    await waitForMessage(
      messages,
      (message) => message.kind === "no-session" && message.sessionId === sessionId,
    );
  } finally {
    socket?.close();
    process.kill();
    await process.exited;
    await rm(root, { recursive: true, force: true });
  }
});

test("disconnecting the owning socket cancels and removes a headless Boss turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "workbench-headless-disconnect-"));
  const sessions = join(root, "sessions");
  const stateFile = join(root, "server.json");
  const methodLog = join(root, "methods.log");
  const pidFile = join(root, "acp.pid");
  const bin = join(root, "bin");
  await mkdir(bin);
  await writeFakeOuro(bin, "--slow-prompt-ms 5000");
  const serverProcess = Bun.spawn(["bun", "server.ts"], {
    cwd: join(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...globalThis.process.env,
      PATH: `${bin}:${globalThis.process.env.PATH ?? ""}`,
      BUN_BIN: Bun.which("bun") ?? "bun",
      FAKE_ACP_SCRIPT: join(import.meta.dir, "fake-acp.ts"),
      FAKE_ACP_METHOD_LOG: methodLog,
      FAKE_ACP_PID_FILE: pidFile,
      CMUX_AGENT_CHAT_PORT: "0",
      CMUX_AGENT_CHAT_STATE_FILE: stateFile,
      CMUX_AGENT_CHAT_SESSION_DIR: sessions,
      CMUX_AGENT_CHAT_TOKEN: "disconnect-token",
      CMUX_AGENT_CHAT_PRODUCT: "ouro-workbench-v1",
      CMUX_AGENT_CHAT_BOSS_AGENT: "slugger",
      CMUX_AGENT_CHAT_CONTEXT_LABEL: "Desk / disconnect-fixture",
      CMUX_AGENT_CHAT_ALLOWED_ROOTS: root,
      CMUX_AGENT_UI_CWD: root,
      CMUX_AGENT_MODELS_URL: "http://127.0.0.1:1",
    },
  });
  let socket: WebSocket | null = null;

  try {
    const port = await waitForPort(stateFile);
    socket = new WebSocket(`ws://127.0.0.1:${port}/disconnect-token/ws`);
    const messages: any[] = [];
    socket.onmessage = (event) => messages.push(JSON.parse(String(event.data)));
    await new Promise<void>((resolve, reject) => {
      socket!.onopen = () => resolve();
      socket!.onerror = () => reject(new Error("WebSocket failed to open"));
    });
    socket.send(JSON.stringify({
      op: "headless-start",
      requestId: "disconnect-1",
      provider: "ouro-boss",
      cwd: root,
      prompt: "Wait before replying.",
      autoApprove: false,
      options: {},
    }));
    await waitForMessage(
      messages,
      (message) => message.kind === "session-created" && message.requestId === "disconnect-1",
    );
    await waitForMessage(
      messages,
      (message) => message.kind === "event"
        && message.evt?.kind === "connection"
        && message.evt?.state === "ready",
    );
    await waitForMessage(
      messages,
      (message) => message.kind === "event" && message.evt?.kind === "user",
    );
    const promptDeadline = Date.now() + 5_000;
    let promptMethods = "";
    while (Date.now() < promptDeadline) {
      promptMethods = await readFile(methodLog, "utf8").catch(() => "");
      if (promptMethods.includes("session/prompt")) break;
      await Bun.sleep(20);
    }
    expect(promptMethods).toContain("session/prompt");
    const acpPid = Number(await readFile(pidFile, "utf8"));
    const closed = new Promise<void>((resolve) => {
      socket!.onclose = () => resolve();
    });
    socket.close();
    await closed;
    socket = null;

    const deadline = Date.now() + 5_000;
    let acpAlive = true;
    while (Date.now() < deadline) {
      try {
        globalThis.process.kill(acpPid, 0);
      } catch {
        acpAlive = false;
        break;
      }
      await Bun.sleep(20);
    }
    expect(acpAlive).toBe(false);
    const visible = await fetch(`http://127.0.0.1:${port}/disconnect-token/api/sessions`).then((response) => response.json());
    expect(visible).toEqual([]);
    expect(await readdir(sessions).catch(() => [])).toEqual([]);
  } finally {
    socket?.close();
    serverProcess.kill();
    await serverProcess.exited;
    await rm(root, { recursive: true, force: true });
  }
}, 12_000);

test("disconnecting before validation prevents a late headless Boss launch", async () => {
  const root = await mkdtemp(join(tmpdir(), "workbench-headless-early-disconnect-"));
  const stateFile = join(root, "server.json");
  const methodLog = join(root, "methods.log");
  const bin = join(root, "bin");
  await mkdir(bin);
  await writeFakeOuro(bin);
  const serverProcess = Bun.spawn(["bun", "server.ts"], {
    cwd: join(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...globalThis.process.env,
      PATH: `${bin}:${globalThis.process.env.PATH ?? ""}`,
      BUN_BIN: Bun.which("bun") ?? "bun",
      FAKE_ACP_SCRIPT: join(import.meta.dir, "fake-acp.ts"),
      FAKE_ACP_METHOD_LOG: methodLog,
      CMUX_AGENT_CHAT_PORT: "0",
      CMUX_AGENT_CHAT_STATE_FILE: stateFile,
      CMUX_AGENT_CHAT_TOKEN: "early-token",
      CMUX_AGENT_CHAT_PRODUCT: "ouro-workbench-v1",
      CMUX_AGENT_CHAT_BOSS_AGENT: "slugger",
      CMUX_AGENT_CHAT_CONTEXT_LABEL: "Desk / early-disconnect-fixture",
      CMUX_AGENT_CHAT_ALLOWED_ROOTS: root,
      CMUX_AGENT_UI_CWD: root,
      CMUX_AGENT_MODELS_URL: "http://127.0.0.1:1",
    },
  });

  try {
    const port = await waitForPort(stateFile);
    const socket = new WebSocket(`ws://127.0.0.1:${port}/early-token/ws`);
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error("WebSocket failed to open"));
    });
    const closed = new Promise<void>((resolve) => {
      socket.onclose = () => resolve();
    });
    socket.send(JSON.stringify({
      op: "headless-start",
      requestId: "early-disconnect",
      provider: "ouro-boss",
      cwd: root,
      prompt: "Do not launch after disconnect.",
      autoApprove: false,
      options: {},
    }));
    socket.close();
    await closed;
    await Bun.sleep(100);

    expect(await readFile(methodLog, "utf8").catch(() => "")).toBe("");
    const visible = await fetch(`http://127.0.0.1:${port}/early-token/api/sessions`).then((response) => response.json());
    expect(visible).toEqual([]);
  } finally {
    serverProcess.kill();
    await serverProcess.exited;
    await rm(root, { recursive: true, force: true });
  }
});
