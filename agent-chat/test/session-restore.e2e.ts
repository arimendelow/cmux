import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
