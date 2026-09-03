import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deletePersistedSession,
  readPersistedSessions,
  writePersistedSession,
  type PersistedAgentChatSession,
} from "../session-persistence";

function record(id = "session-1"): PersistedAgentChatSession {
  return {
    id,
    provider: "copilot",
    providerSessionId: "provider-session-1",
    cwd: "/tmp/workbench-demo",
    title: "GitHub Copilot",
    autoApprove: false,
    startOptions: { mode: "agent" },
    createdAt: 1_725_000_000_000,
  };
}

test("session metadata persists atomically without transcript content", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-chat-session-store-"));
  try {
    await writePersistedSession(directory, record());
    const result = await readPersistedSessions(directory);
    expect(result).toEqual({ records: [record()], errors: [] });
    expect(await readFile(join(directory, "session-1.json"), "utf8")).not.toContain("prompt");
    await deletePersistedSession(directory, "session-1");
    expect(await readPersistedSessions(directory)).toEqual({ records: [], errors: [] });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("session store rejects unsafe ids and reports corrupt records", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-chat-session-store-"));
  try {
    await expect(writePersistedSession(directory, record("../escape"))).rejects.toThrow("invalid session id");
    await writePersistedSession(directory, record("healthy"));
    await writeFile(join(directory, "corrupt.json"), "{not-json", { mode: 0o600 });
    const result = await readPersistedSessions(directory);
    expect(result.records).toEqual([record("healthy")]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("corrupt.json");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
