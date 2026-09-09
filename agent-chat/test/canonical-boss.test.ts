import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  bossCandidateReason,
  canonicalBossPointerPath,
  listBossCandidates,
  listBossCandidatesInPartition,
  parseCanonicalBossPointer,
  readCanonicalBossPointer,
  repointCanonicalBoss,
  resolveCanonicalBoss,
  writeCanonicalBossPointer,
  type BossCandidate,
  type CanonicalBossBlockReason,
  type CanonicalBossPointer,
} from "../canonical-boss";

const scratchRoot = join(import.meta.dir, ".scratch");

async function tempRoot(prefix: string): Promise<string> {
  await mkdir(scratchRoot, { recursive: true });
  return mkdtemp(join(scratchRoot, prefix));
}

function candidate(overrides: Partial<BossCandidate> = {}): BossCandidate {
  return {
    id: "boss-1",
    agent: "slugger",
    provider: "ouro-boss",
    providerSessionId: "provider-1",
    cwd: "/Users/example/desk",
    title: "Boss",
    autoApprove: false,
    startOptions: {},
    createdAt: 1_725_000_000_000,
    loadError: null,
    cwdAvailable: true,
    ...overrides,
  };
}

test("canonical Boss pointer is agent independent and written atomically", async () => {
  const root = await tempRoot("pointer-");
  try {
    expect(canonicalBossPointerPath(root)).toBe(join(root, "canonical-boss.json"));
    expect(await readCanonicalBossPointer(root)).toEqual({ pointer: null, error: null });

    const pointer: CanonicalBossPointer = { version: 1, agent: "slugger", sessionId: "boss-1" };
    await writeCanonicalBossPointer(root, pointer);
    expect(await readCanonicalBossPointer(root)).toEqual({ pointer, error: null });
    expect(JSON.parse(await readFile(canonicalBossPointerPath(root), "utf8"))).toEqual(pointer);
    expect(await readdir(root)).toEqual(["canonical-boss.json"]);

    await writeCanonicalBossPointer(root, { version: 1, agent: "slugger", sessionId: "boss-2" });
    expect((await readCanonicalBossPointer(root)).pointer?.sessionId).toBe("boss-2");
    expect(await readdir(root)).toEqual(["canonical-boss.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("canonical Boss pointer rejects unsafe values and reports corrupt pointers", async () => {
  const root = await tempRoot("pointer-invalid-");
  try {
    await expect(writeCanonicalBossPointer(root, {
      version: 1,
      agent: "../escape",
      sessionId: "boss-1",
    })).rejects.toThrow("agent");
    await expect(writeCanonicalBossPointer(root, {
      version: 1,
      agent: "slugger",
      sessionId: "../escape",
    })).rejects.toThrow("sessionId");

    await writeFile(canonicalBossPointerPath(root), "{not json", { mode: 0o600 });
    const corrupt = await readCanonicalBossPointer(root);
    expect(corrupt.pointer).toBeNull();
    expect(corrupt.error).toContain("canonical-boss.json");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent pointer writes leave exactly one valid pointer", async () => {
  const root = await tempRoot("pointer-race-");
  try {
    await Promise.all(Array.from({ length: 8 }, (_, index) =>
      writeCanonicalBossPointer(root, { version: 1, agent: "slugger", sessionId: `boss-${index}` })));
    const entries = await readdir(root);
    expect(entries).toEqual(["canonical-boss.json"]);
    const result = await readCanonicalBossPointer(root);
    expect(result.error).toBeNull();
    expect(result.pointer?.sessionId).toMatch(/^boss-\d$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Boss candidates are collected across agent partitions without deleting records", async () => {
  const root = await tempRoot("candidates-");
  try {
    const workdir = join(root, "work");
    await mkdir(workdir, { recursive: true });
    await mkdir(join(root, "slugger"), { recursive: true });
    await mkdir(join(root, "other"), { recursive: true });
    await writeFile(join(root, "slugger", "boss-1.json"), JSON.stringify({
      id: "boss-1",
      provider: "ouro-boss",
      providerSessionId: "provider-1",
      cwd: workdir,
      title: "Boss",
      autoApprove: false,
      startOptions: {},
      createdAt: 10,
    }), { mode: 0o600 });
    await writeFile(join(root, "other", "boss-2.json"), JSON.stringify({
      id: "boss-2",
      provider: "ouro-boss",
      providerSessionId: "provider-2",
      cwd: workdir,
      title: "Boss",
      autoApprove: false,
      startOptions: {},
      createdAt: 20,
    }), { mode: 0o600 });
    await writeFile(join(root, "slugger", "broken.json"), "{oops", { mode: 0o600 });

    const candidates = await listBossCandidates(root);
    expect(candidates.map((entry) => `${entry.agent}/${entry.id}`).sort()).toEqual([
      "other/boss-2",
      "slugger/boss-1",
      "slugger/broken",
    ]);
    expect(candidates.find((entry) => entry.id === "broken")?.loadError).toContain("JSON");
    expect(candidates.find((entry) => entry.id === "boss-1")?.cwdAvailable).toBe(true);
    expect((await readdir(join(root, "slugger"))).sort()).toEqual(["boss-1.json", "broken.json"]);

    await rm(workdir, { recursive: true, force: true });
    const afterCwdLoss = await listBossCandidates(root);
    expect(afterCwdLoss.find((entry) => entry.id === "boss-1")?.cwdAvailable).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("migration pins the exact routed session before considering any other candidate", () => {
  const state = resolveCanonicalBoss({
    pointer: null,
    configuredAgent: "slugger",
    routedSessionId: "boss-1",
    candidates: [
      candidate({ id: "boss-1", createdAt: 10 }),
      candidate({ id: "boss-2", createdAt: 99, providerSessionId: "provider-2" }),
    ],
  });
  expect(state).toEqual({
    status: "adopt",
    pointer: { version: 1, agent: "slugger", sessionId: "boss-1" },
    skipped: [{ id: "boss-2", agent: "slugger", reason: "not-canonical" }],
  });
});

test("migration adopts exactly one valid persisted Boss and never picks by recency", () => {
  expect(resolveCanonicalBoss({
    pointer: null,
    configuredAgent: "slugger",
    routedSessionId: null,
    candidates: [candidate({ id: "boss-1" })],
  })).toEqual({
    status: "adopt",
    pointer: { version: 1, agent: "slugger", sessionId: "boss-1" },
    skipped: [],
  });

  const ambiguous = resolveCanonicalBoss({
    pointer: null,
    configuredAgent: "slugger",
    routedSessionId: null,
    candidates: [
      candidate({ id: "boss-1", createdAt: 10 }),
      candidate({ id: "boss-2", createdAt: 99, providerSessionId: "provider-2" }),
    ],
  });
  expect(ambiguous.status).toBe("blocked");
  if (ambiguous.status !== "blocked") throw new Error("expected blocked");
  expect(ambiguous.reason).toBe("ambiguous-candidates");
  expect(ambiguous.detail).toBe("2 persisted Boss sessions match agent slugger: boss-1, boss-2");
  expect(ambiguous.candidates.map((entry) => entry.id)).toEqual(["boss-1", "boss-2"]);
});

test("a clean install with no candidate is allowed to create the first Boss", () => {
  expect(resolveCanonicalBoss({
    pointer: null,
    configuredAgent: "slugger",
    routedSessionId: null,
    candidates: [],
  })).toEqual({ status: "none", skipped: [] });
});

test("migration blocks visibly instead of replacing an unusable sole candidate", () => {
  const corrupt = resolveCanonicalBoss({
    pointer: null,
    configuredAgent: "slugger",
    routedSessionId: null,
    candidates: [candidate({ id: "broken", loadError: "broken.json: bad JSON" })],
  });
  expect(corrupt.status).toBe("blocked");
  if (corrupt.status !== "blocked") throw new Error("expected blocked");
  expect(corrupt.reason).toBe("corrupt-record");
  expect(corrupt.detail).toBe("broken.json: bad JSON");

  const missingCwd = resolveCanonicalBoss({
    pointer: null,
    configuredAgent: "slugger",
    routedSessionId: null,
    candidates: [candidate({ id: "boss-1", cwdAvailable: false })],
  });
  expect(missingCwd.status).toBe("blocked");
  if (missingCwd.status !== "blocked") throw new Error("expected blocked");
  expect(missingCwd.reason).toBe("cwd-unavailable");
  expect(missingCwd.detail).toBe("boss-1 cannot load: working directory /Users/example/desk is unavailable");

  const mismatched = resolveCanonicalBoss({
    pointer: null,
    configuredAgent: "slugger",
    routedSessionId: null,
    candidates: [candidate({ id: "boss-1", agent: "other" })],
  });
  expect(mismatched.status).toBe("blocked");
  if (mismatched.status !== "blocked") throw new Error("expected blocked");
  expect(mismatched.reason).toBe("agent-mismatch");
  expect(mismatched.detail).toBe("boss-1 belongs to agent other, not slugger");
});

test("an existing pointer resolves without re-running migration and stays idempotent", () => {
  const pointer: CanonicalBossPointer = { version: 1, agent: "slugger", sessionId: "boss-1" };
  const resolved = resolveCanonicalBoss({
    pointer,
    configuredAgent: "slugger",
    routedSessionId: "boss-2",
    candidates: [
      candidate({ id: "boss-1" }),
      candidate({ id: "boss-2", providerSessionId: "provider-2" }),
    ],
  });
  expect(resolved).toEqual({
    status: "canonical",
    pointer,
    session: candidate({ id: "boss-1" }),
    skipped: [{ id: "boss-2", agent: "slugger", reason: "not-canonical" }],
  });

  expect(resolveCanonicalBoss({
    pointer,
    configuredAgent: "slugger",
    routedSessionId: null,
    candidates: [candidate({ id: "boss-1" })],
  }).status).toBe("canonical");
});

test("every referenced-record failure blocks with an exact reason and keeps the record", () => {
  const pointer: CanonicalBossPointer = { version: 1, agent: "slugger", sessionId: "boss-1" };
  const cases: [Parameters<typeof resolveCanonicalBoss>[0], CanonicalBossBlockReason, string][] = [
    [
      { pointer, configuredAgent: "slugger", routedSessionId: null, candidates: [] },
      "missing-record",
      "canonical Boss session boss-1 is not in the session store",
    ],
    [
      {
        pointer,
        configuredAgent: "slugger",
        routedSessionId: null,
        candidates: [candidate({ id: "boss-1", loadError: "boss-1.json: bad JSON" })],
      },
      "corrupt-record",
      "boss-1.json: bad JSON",
    ],
    [
      {
        pointer,
        configuredAgent: "slugger",
        routedSessionId: null,
        candidates: [candidate({ id: "boss-1", cwdAvailable: false })],
      },
      "cwd-unavailable",
      "boss-1 cannot load: working directory /Users/example/desk is unavailable",
    ],
    [
      {
        pointer,
        configuredAgent: "slugger",
        routedSessionId: null,
        candidates: [candidate({ id: "boss-1", agent: "other" })],
      },
      "agent-mismatch",
      "boss-1 belongs to agent other, not slugger",
    ],
    [
      {
        pointer,
        configuredAgent: "other",
        routedSessionId: null,
        candidates: [candidate({ id: "boss-1" })],
      },
      "agent-mismatch",
      "canonical Boss agent slugger is not the configured agent other",
    ],
  ];
  for (const [input, reason, detail] of cases) {
    const state = resolveCanonicalBoss(input);
    expect(state.status).toBe("blocked");
    if (state.status !== "blocked") throw new Error("expected blocked");
    expect(state.reason).toBe(reason);
    expect(state.detail).toBe(detail);
    expect(state.pointer).toEqual(pointer);
  }
});

test("an unconfigured Boss agent blocks rather than adopting an arbitrary partition", () => {
  const state = resolveCanonicalBoss({
    pointer: null,
    configuredAgent: "",
    routedSessionId: null,
    candidates: [candidate({ id: "boss-1" })],
  });
  expect(state.status).toBe("blocked");
  if (state.status !== "blocked") throw new Error("expected blocked");
  expect(state.reason).toBe("agent-unconfigured");
  expect(state.detail).toBe("no Boss agent is configured");
});

test("skipped restore reasons are exact and human readable", () => {
  expect(bossCandidateReason(candidate({ loadError: "boss-1.json: bad JSON" }), "slugger")).toBe("corrupt-record");
  expect(bossCandidateReason(candidate({ cwdAvailable: false }), "slugger")).toBe("cwd-unavailable");
  expect(bossCandidateReason(candidate({ agent: "other" }), "slugger")).toBe("agent-mismatch");
  expect(bossCandidateReason(candidate(), "slugger")).toBe(null);
});

test("repair repoints the canonical pointer atomically and preserves every transcript", async () => {
  const root = await tempRoot("repair-");
  try {
    const workdir = join(root, "work");
    await mkdir(workdir, { recursive: true });
    await mkdir(join(root, "slugger"), { recursive: true });
    for (const id of ["boss-1", "boss-2"]) {
      await writeFile(join(root, "slugger", `${id}.json`), JSON.stringify({
        id,
        provider: "ouro-boss",
        providerSessionId: `provider-${id}`,
        cwd: workdir,
        title: "Boss",
        autoApprove: false,
        startOptions: {},
        createdAt: 10,
      }), { mode: 0o600 });
    }
    await writeCanonicalBossPointer(root, { version: 1, agent: "slugger", sessionId: "boss-1" });

    const repointed = await repointCanonicalBoss(root, { agent: "slugger", sessionId: "boss-2" });
    expect(repointed.ok).toBe(true);
    expect(repointed.ok === true ? repointed.pointer : null)
      .toEqual({ version: 1, agent: "slugger", sessionId: "boss-2" });
    expect(repointed.ok === true ? repointed.session.id : "").toBe("boss-2");
    expect((await readCanonicalBossPointer(root)).pointer?.sessionId).toBe("boss-2");
    expect((await readdir(join(root, "slugger"))).sort()).toEqual(["boss-1.json", "boss-2.json"]);

    expect(await repointCanonicalBoss(root, { agent: "slugger", sessionId: "boss-9" })).toEqual({
      ok: false,
      error: "no persisted Boss session slugger/boss-9",
    });
    // Repair cannot write a pointer the next start would reject.
    expect(await repointCanonicalBoss(
      root,
      { agent: "slugger", sessionId: "boss-2" },
      { configuredAgent: "other" },
    )).toEqual({ ok: false, error: "slugger is not the configured agent other" });
    expect((await readCanonicalBossPointer(root)).pointer?.sessionId).toBe("boss-2");
  } finally {
    await chmod(root, 0o700).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("pointer parsing rejects non-object and non-v1 payloads", () => {
  expect(() => parseCanonicalBossPointer(null)).toThrow("canonical Boss pointer must be an object");
  expect(() => parseCanonicalBossPointer([])).toThrow("canonical Boss pointer must be an object");
  expect(() => parseCanonicalBossPointer({ version: 2, agent: "a", sessionId: "b" }))
    .toThrow("canonical Boss pointer version must be 1");
});

test("a routed session that is itself unusable blocks with its own reason", () => {
  const state = resolveCanonicalBoss({
    pointer: null,
    configuredAgent: "slugger",
    routedSessionId: "broken",
    candidates: [
      candidate({ id: "broken", loadError: "broken.json: bad JSON" }),
      candidate({ id: "boss-1" }),
    ],
  });
  expect(state.status).toBe("blocked");
  if (state.status !== "blocked") throw new Error("expected blocked");
  expect(state.reason).toBe("corrupt-record");
  expect(state.detail).toBe("broken.json: bad JSON");

  // A routed id with no matching record falls through to normal migration.
  expect(resolveCanonicalBoss({
    pointer: null,
    configuredAgent: "slugger",
    routedSessionId: "absent",
    candidates: [candidate({ id: "boss-1" })],
  })).toEqual({
    status: "adopt",
    pointer: { version: 1, agent: "slugger", sessionId: "boss-1" },
    skipped: [],
  });
});

test("candidate listing tolerates a missing root, a missing partition, and malformed records", async () => {
  const root = await tempRoot("candidates-missing-");
  try {
    expect(await listBossCandidates(join(root, "absent"))).toEqual([]);
    expect(await listBossCandidatesInPartition(join(root, "absent"), "slugger")).toEqual([]);

    const partition = join(root, "slugger");
    await mkdir(partition, { recursive: true });
    await writeFile(join(partition, "no-autoapprove.json"), JSON.stringify({
      id: "no-autoapprove",
      provider: "ouro-boss",
      providerSessionId: "p",
      cwd: root,
      title: "Boss",
      createdAt: 1,
    }), { mode: 0o600 });
    await writeFile(join(partition, "no-createdat.json"), JSON.stringify({
      id: "no-createdat",
      provider: "ouro-boss",
      providerSessionId: "p",
      cwd: root,
      title: "Boss",
      autoApprove: false,
    }), { mode: 0o600 });
    await writeFile(join(partition, "not-an-object.json"), "[]", { mode: 0o600 });
    await writeFile(join(partition, "canonical-boss.json"), "{}", { mode: 0o600 });

    const candidates = await listBossCandidates(root);
    expect(candidates.map((entry) => entry.id).sort()).toEqual([
      "no-autoapprove",
      "no-createdat",
      "not-an-object",
    ]);
    expect(candidates.find((entry) => entry.id === "no-autoapprove")?.loadError)
      .toContain("autoApprove must be boolean");
    expect(candidates.find((entry) => entry.id === "no-createdat")?.loadError)
      .toContain("createdAt must be finite");
    expect(candidates.find((entry) => entry.id === "not-an-object")?.loadError)
      .toContain("session record must be an object");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repair rejects an unsafe target and a corrupt candidate without writing a pointer", async () => {
  const root = await tempRoot("repair-invalid-");
  try {
    const partition = join(root, "slugger");
    await mkdir(partition, { recursive: true });
    await writeFile(join(partition, "broken.json"), "{oops", { mode: 0o600 });

    expect(await repointCanonicalBoss(root, { agent: "../escape", sessionId: "boss-1" })).toEqual({
      ok: false,
      error: "invalid canonical Boss agent: ../escape",
    });
    const corrupt = await repointCanonicalBoss(root, { agent: "slugger", sessionId: "broken" });
    expect(corrupt.ok).toBe(false);
    expect(corrupt.ok === false ? corrupt.error : "").toContain("broken.json");
    expect(await readCanonicalBossPointer(root)).toEqual({ pointer: null, error: null });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an atomic pointer write cleans up after a failed rename", async () => {
  const root = await tempRoot("pointer-failure-");
  try {
    await mkdir(canonicalBossPointerPath(root), { recursive: true });
    await expect(writeCanonicalBossPointer(root, {
      version: 1,
      agent: "slugger",
      sessionId: "boss-1",
    })).rejects.toThrow();
    expect(await readdir(root)).toEqual(["canonical-boss.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
