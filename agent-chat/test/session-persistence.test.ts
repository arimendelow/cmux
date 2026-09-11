import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
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
    startRequestId: "request-1",
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
    await expect(writePersistedSession(directory, { ...record("bad-request"), startRequestId: "../escape" })).rejects.toThrow("invalid startRequestId");
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

test("session validation rejects malformed metadata before creating a store", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-chat-invalid-metadata-"));
  const directory = join(root, "uncreated");
  try {
    const invalid: Array<[unknown, string]> = [
      [null, "session record must be an object"],
      [false, "session record must be an object"],
      [[], "session record must be an object"],
      [{ ...record(), id: 1 }, "id must be a non-empty string"],
      [{ ...record(), id: " " }, "id must be a non-empty string"],
      [{ ...record(), provider: "" }, "provider must be a non-empty string"],
      [{ ...record(), providerSessionId: null }, "providerSessionId must be a non-empty string"],
      [{ ...record(), cwd: "relative/path" }, "cwd must be absolute"],
      [{ ...record(), title: "\t" }, "title must be a non-empty string"],
      [{ ...record(), startRequestId: "" }, "startRequestId must be a non-empty string"],
      [{ ...record(), autoApprove: "false" }, "autoApprove must be boolean"],
      [{ ...record(), createdAt: "1" }, "createdAt must be finite"],
      [{ ...record(), createdAt: Infinity }, "createdAt must be finite"],
      [{ ...record(), createdAt: NaN }, "createdAt must be finite"],
      [{ ...record(), startOptions: null }, "startOptions must be an object"],
      [{ ...record(), startOptions: "mode" }, "startOptions must be an object"],
      [{ ...record(), startOptions: [] }, "startOptions must be an object"],
      [{ ...record(), startOptions: { mode: 1 } }, "startOptions.mode must be a string or boolean"],
    ];
    for (const [value, error] of invalid) {
      await expect(writePersistedSession(directory, value as PersistedAgentChatSession)).rejects.toThrow(error);
      expect(await readdir(root)).toEqual([]);
    }
    await expect(deletePersistedSession(directory, "../escape")).rejects.toThrow("invalid session id");
    expect(await readPersistedSessions(directory)).toEqual({ records: [], errors: [] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session reads preserve malformed files and return valid records in filename order", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-chat-read-metadata-"));
  try {
    const { startRequestId: _request, ...withoutRequest } = record("a-session");
    const first = { ...withoutRequest, startOptions: { model: "fixture-model", autoApprove: true } };
    await writePersistedSession(directory, record("z-session"));
    await writePersistedSession(directory, first);
    await writeFile(join(directory, "ignored.tmp"), "not JSON");
    await writeFile(join(directory, "broken.json"), "null");
    const before = await readFile(join(directory, "broken.json"), "utf8");
    expect(await readPersistedSessions(directory)).toEqual({
      records: [first, record("z-session")],
      errors: ["broken.json: session record must be an object"],
    });
    expect(await readFile(join(directory, "broken.json"), "utf8")).toBe(before);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(join(directory, "a-session.json"))).mode & 0o777).toBe(0o600);
    await deletePersistedSession(directory, "absent");
    expect((await readdir(directory)).sort()).toEqual(["a-session.json", "broken.json", "ignored.tmp", "z-session.json"]);
    await expect(readPersistedSessions(join(directory, "ignored.tmp"))).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("failed session replacement removes its temporary file and preserves the destination", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-chat-replace-metadata-"));
  try {
    const destination = join(directory, "session-1.json");
    await mkdir(destination);
    await writeFile(join(destination, "keep"), "existing destination");
    await expect(writePersistedSession(directory, record())).rejects.toThrow();
    expect(await readdir(directory)).toEqual(["session-1.json"]);
    expect(await readFile(join(destination, "keep"), "utf8")).toBe("existing destination");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
