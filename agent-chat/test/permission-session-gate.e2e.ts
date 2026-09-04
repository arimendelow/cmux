import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
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

async function waitFor(messages: any[], predicate: (message: any) => boolean): Promise<any> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const match = messages.find(predicate);
    if (match) return match;
    await Bun.sleep(20);
  }
  throw new Error(`timed out waiting for message: ${JSON.stringify(messages)}`);
}

async function openSocket(url: string, messages: any[]): Promise<WebSocket> {
  const socket = new WebSocket(url);
  socket.onmessage = (event) => messages.push(JSON.parse(String(event.data)));
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = () => reject(new Error("WebSocket failed to open"));
  });
  return socket;
}

test("only the socket subscribed to a session can answer its permission request", async () => {
  const root = await mkdtemp(join(tmpdir(), "workbench-permission-gate-"));
  const stateFile = join(root, "server.json");
  const bin = join(root, "bin");
  await mkdir(bin);
  const ouro = join(bin, "ouro");
  await Bun.write(ouro, "#!/bin/sh\nexec \"$BUN_BIN\" \"$FAKE_ACP_SCRIPT\" --request-permission\n");
  await chmod(ouro, 0o755);
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
      CMUX_AGENT_CHAT_TOKEN: "permission-gate-token",
      CMUX_AGENT_CHAT_PRODUCT: "ouro-workbench-v1",
      CMUX_AGENT_CHAT_BOSS_AGENT: "slugger",
      CMUX_AGENT_CHAT_ALLOWED_ROOTS: root,
      CMUX_AGENT_UI_CWD: root,
      CMUX_AGENT_MODELS_URL: "http://127.0.0.1:1",
    },
  });
  let owner: WebSocket | null = null;
  let other: WebSocket | null = null;

  try {
    const port = await waitForPort(stateFile);
    const ownerMessages: any[] = [];
    const otherMessages: any[] = [];
    owner = await openSocket(`ws://127.0.0.1:${port}/permission-gate-token/ws`, ownerMessages);
    other = await openSocket(`ws://127.0.0.1:${port}/permission-gate-token/ws`, otherMessages);
    owner.send(JSON.stringify({
      op: "start",
      requestId: "permission-owner",
      provider: "ouro-boss",
      cwd: root,
      prompt: "request permission",
    }));
    const created = await waitFor(ownerMessages, (message) => message.kind === "session-created");
    const request = await waitFor(
      ownerMessages,
      (message) => message.kind === "event" && message.evt?.kind === "permission-request",
    );
    other.send(JSON.stringify({
      op: "permission-response",
      sessionId: created.session.id,
      requestId: request.evt.requestId,
      optionId: "allow-once",
    }));
    await Bun.sleep(100);
    expect(ownerMessages.some(
      (message) => message.kind === "event" && message.evt?.kind === "permission-resolved",
    )).toBe(false);
    owner.send(JSON.stringify({
      op: "permission-response",
      sessionId: created.session.id,
      requestId: request.evt.requestId,
      optionId: "allow-once",
    }));
    await waitFor(
      ownerMessages,
      (message) => message.kind === "event"
        && message.evt?.kind === "permission-resolved"
        && message.evt.requestId === request.evt.requestId,
    );
  } finally {
    owner?.close();
    other?.close();
    process.kill();
    await process.exited;
    await rm(root, { recursive: true, force: true });
  }
}, 10_000);
