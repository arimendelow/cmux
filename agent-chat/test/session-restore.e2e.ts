import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePersistedSession } from "../session-persistence";

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

test("fresh sidecar restores persisted session metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-chat-restore-"));
  const sessions = join(root, "sessions");
  const stateFile = join(root, "server.json");
  await writePersistedSession(sessions, {
    id: "restored-1",
    provider: "copilot",
    providerSessionId: "provider-session-1",
    cwd: root,
    title: "GitHub Copilot",
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
      CMUX_AGENT_CHAT_PORT: "0",
      CMUX_AGENT_CHAT_STATE_FILE: stateFile,
      CMUX_AGENT_CHAT_SESSION_DIR: sessions,
      CMUX_AGENT_MODELS_URL: "http://127.0.0.1:1",
    },
  });

  try {
    const port = await waitForPort(stateFile);
    const response = await fetch(`http://127.0.0.1:${port}/api/sessions`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      expect.objectContaining({
        id: "restored-1",
        provider: "copilot",
        title: "GitHub Copilot",
        status: "idle",
      }),
    ]);
  } finally {
    process.kill();
    await process.exited;
    await rm(root, { recursive: true, force: true });
  }
});

test("token-authenticated shutdown stops the owned sidecar", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-chat-shutdown-"));
  const stateFile = join(root, "server.json");
  const childPidFile = join(root, "child.pid");
  const bin = join(root, "bin");
  await mkdir(bin);
  const ouro = join(bin, "ouro");
  await Bun.write(ouro, "#!/bin/sh\nexec \"$BUN_BIN\" \"$FAKE_ACP_SCRIPT\"\n");
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
      FAKE_ACP_PID_FILE: childPidFile,
      CMUX_AGENT_CHAT_PORT: "0",
      CMUX_AGENT_CHAT_STATE_FILE: stateFile,
      CMUX_AGENT_CHAT_TOKEN: "shutdown-token",
      CMUX_AGENT_CHAT_PRODUCT: "ouro-workbench-v1",
      CMUX_AGENT_CHAT_BOSS_AGENT: "slugger",
      CMUX_AGENT_CHAT_ALLOWED_ROOTS: root,
      CMUX_AGENT_UI_CWD: root,
      CMUX_AGENT_MODELS_URL: "http://127.0.0.1:1",
    },
  });

  try {
    const port = await waitForPort(stateFile);
    const socket = new WebSocket(`ws://127.0.0.1:${port}/shutdown-token/ws`);
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error("WebSocket failed to open"));
    });
    socket.send(JSON.stringify({
      op: "start",
      requestId: "shutdown-child",
      provider: "ouro-boss",
      cwd: root,
      prompt: "start child",
    }));
    const childDeadline = Date.now() + 2_000;
    while (Date.now() < childDeadline) {
      try {
        if (Number(await readFile(childPidFile, "utf8"))) break;
      } catch {}
      await Bun.sleep(20);
    }
    const childPid = Number((await readFile(childPidFile, "utf8")).trim());
    const response = await fetch(`http://127.0.0.1:${port}/shutdown-token/api/shutdown`, { method: "POST" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    const exitCode = await Promise.race([
      process.exited,
      Bun.sleep(2_000).then(() => "timeout" as const),
    ]);
    expect(exitCode).not.toBe("timeout");
    let childRunning = true;
    const childExitDeadline = Date.now() + 1_000;
    while (Date.now() < childExitDeadline) {
      try {
        globalThis.process.kill(childPid, 0);
      } catch {
        childRunning = false;
        break;
      }
      await Bun.sleep(20);
    }
    expect(childRunning).toBe(false);
    socket.close();
  } finally {
    if (process.exitCode === null) process.kill();
    await process.exited;
    await rm(root, { recursive: true, force: true });
  }
});
