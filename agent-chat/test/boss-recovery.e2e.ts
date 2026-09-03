import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePersistedSession } from "../session-persistence";
import { pickInitialBossSession, type WorkbenchExperience } from "../src/session";

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

async function waitForMessage(
  messages: any[],
  predicate: (message: any) => boolean,
): Promise<any> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const match = messages.find(predicate);
    if (match) return match;
    await Bun.sleep(20);
  }
  throw new Error(`timed out waiting for message: ${JSON.stringify(messages)}`);
}

test("Workbench root resumes the persisted Boss with a verified recovery event", async () => {
  const root = await mkdtemp(join(tmpdir(), "workbench-boss-recovery-"));
  const sessions = join(root, "sessions");
  const stateFile = join(root, "server.json");
  const bin = join(root, "bin");
  const agency = join(bin, "agency");
  await mkdir(bin);
  await Bun.write(agency, "#!/bin/sh\nexec \"$BUN_BIN\" \"$FAKE_ACP_SCRIPT\"\n");
  await chmod(agency, 0o755);
  await writePersistedSession(sessions, {
    id: "boss-restored",
    provider: "agency-worker",
    providerSessionId: "provider-session-1",
    cwd: root,
    title: "Boss",
    autoApprove: false,
    startOptions: {},
    createdAt: 1_725_000_000_000,
  });
  const process = Bun.spawn(["bun", "server.ts"], {
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
      CMUX_AGENT_CHAT_SESSION_DIR: sessions,
      CMUX_AGENT_CHAT_TOKEN: "recovery-token",
      CMUX_AGENT_CHAT_PRODUCT: "ouro-workbench-v1",
      CMUX_AGENT_CHAT_CONTEXT_LABEL: "Desk / recovery-fixture",
      CMUX_AGENT_CHAT_ALLOWED_ROOTS: root,
      CMUX_AGENT_UI_CWD: root,
      CMUX_AGENT_MODELS_URL: "http://127.0.0.1:1",
    },
  });
  let socket: WebSocket | null = null;

  try {
    const port = await waitForPort(stateFile);
    socket = new WebSocket(`ws://127.0.0.1:${port}/recovery-token/ws`);
    const messages: any[] = [];
    socket.onmessage = (event) => messages.push(JSON.parse(String(event.data)));
    await new Promise<void>((resolve, reject) => {
      socket!.onopen = () => resolve();
      socket!.onerror = () => reject(new Error("WebSocket failed to open"));
    });
    const hello = await waitForMessage(messages, (message) => message.kind === "hello");
    const listed = await waitForMessage(messages, (message) => message.kind === "sessions");
    expect(hello.providers.map((provider: any) => provider.id)).toEqual(["agency-worker", "copilot"]);
    const recovered = pickInitialBossSession(
      listed.sessions,
      hello.experience as WorkbenchExperience,
    );
    expect(recovered?.id).toBe("boss-restored");
    socket.send(JSON.stringify({ op: "subscribe", sessionId: recovered!.id }));
    await waitForMessage(messages, (message) => message.kind === "history" && message.sessionId === recovered!.id);
    const recovery = await waitForMessage(
      messages,
      (message) => message.kind === "event" && message.evt?.kind === "recovery",
    );
    expect(recovery.evt).toEqual({
      kind: "recovery",
      mode: "resumed",
      title: "Conversation resumed",
      message: "Loaded the existing provider session after Workbench restarted.",
    });
    expect(messages).toContainEqual(expect.objectContaining({
      kind: "event",
      evt: { kind: "user", text: "previous question" },
    }));
    expect(messages).toContainEqual(expect.objectContaining({
      kind: "event",
      evt: { kind: "delta", text: "previous answer" },
    }));
  } finally {
    socket?.close();
    process.kill();
    await process.exited;
    await rm(root, { recursive: true, force: true });
  }
});
