import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { access } from "node:fs/promises";
import { join } from "node:path";
import type { OptionValue } from "./types";

// The canonical Boss pointer is deliberately agent independent: session records
// stay partitioned by agent, but resolution always starts from one app-global
// pointer so no client ever has to guess which conversation is Boss.
export const CANONICAL_BOSS_POINTER_FILE = "canonical-boss.json";

export interface CanonicalBossPointer {
  version: 1;
  agent: string;
  sessionId: string;
}

export interface BossCandidate {
  id: string;
  agent: string;
  provider: string;
  providerSessionId: string;
  cwd: string;
  title: string;
  autoApprove: boolean;
  startOptions: Record<string, OptionValue>;
  createdAt: number;
  /** Non-null when the record could not be parsed; the file is never removed. */
  loadError: string | null;
  cwdAvailable: boolean;
}

export type BossSkipReason =
  | "corrupt-record"
  | "cwd-unavailable"
  | "agent-mismatch"
  | "not-canonical";

export type CanonicalBossBlockReason =
  | "ambiguous-candidates"
  | "missing-record"
  | "corrupt-record"
  | "cwd-unavailable"
  | "agent-mismatch"
  | "agent-unconfigured";

export interface BossSkippedRecord {
  id: string;
  agent: string;
  reason: BossSkipReason;
}

export type CanonicalBossState =
  | { status: "none"; skipped: BossSkippedRecord[] }
  | { status: "adopt"; pointer: CanonicalBossPointer; skipped: BossSkippedRecord[] }
  | {
    status: "canonical";
    pointer: CanonicalBossPointer;
    session: BossCandidate;
    skipped: BossSkippedRecord[];
  }
  | {
    status: "blocked";
    reason: CanonicalBossBlockReason;
    detail: string;
    pointer: CanonicalBossPointer | null;
    candidates: BossCandidate[];
    skipped: BossSkippedRecord[];
  };

const safeNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function assertSafe(value: string, field: "agent" | "sessionId") {
  if (!safeNamePattern.test(value)) throw new Error(`invalid canonical Boss ${field}: ${value}`);
}

export function canonicalBossPointerPath(root: string): string {
  return join(root, CANONICAL_BOSS_POINTER_FILE);
}

export function parseCanonicalBossPointer(value: unknown): CanonicalBossPointer {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("canonical Boss pointer must be an object");
  }
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1) throw new Error("canonical Boss pointer version must be 1");
  const agent = typeof raw.agent === "string" ? raw.agent : "";
  const sessionId = typeof raw.sessionId === "string" ? raw.sessionId : "";
  assertSafe(agent, "agent");
  assertSafe(sessionId, "sessionId");
  return { version: 1, agent, sessionId };
}

export async function writeCanonicalBossPointer(root: string, pointer: CanonicalBossPointer) {
  const validated = parseCanonicalBossPointer(pointer);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const destination = canonicalBossPointerPath(root);
  const temporary = join(root, `.${CANONICAL_BOSS_POINTER_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(validated)}\n`, { mode: 0o600 });
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function removeCanonicalBossPointer(
  root: string,
  expected: CanonicalBossPointer,
): Promise<boolean> {
  const current = await readCanonicalBossPointer(root);
  if (!current.pointer
    || current.pointer.agent !== expected.agent
    || current.pointer.sessionId !== expected.sessionId) {
    return false;
  }
  await rm(canonicalBossPointerPath(root), { force: true });
  return true;
}

export async function readCanonicalBossPointer(
  root: string,
): Promise<{ pointer: CanonicalBossPointer | null; error: string | null }> {
  try {
    const contents = await readFile(canonicalBossPointerPath(root), "utf8");
    return { pointer: parseCanonicalBossPointer(JSON.parse(contents)), error: null };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { pointer: null, error: null };
    return {
      pointer: null,
      error: `${CANONICAL_BOSS_POINTER_FILE}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function candidateFromRecord(agent: string, id: string, raw: unknown): BossCandidate {
  const record = raw as Record<string, unknown>;
  return {
    id,
    agent,
    provider: String(record.provider ?? ""),
    providerSessionId: String(record.providerSessionId ?? ""),
    cwd: String(record.cwd ?? ""),
    title: String(record.title ?? ""),
    autoApprove: record.autoApprove === true,
    startOptions: (record.startOptions ?? {}) as Record<string, OptionValue>,
    createdAt: Number(record.createdAt ?? 0),
    loadError: null,
    cwdAvailable: true,
  };
}

function requireRecordShape(raw: unknown) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("session record must be an object");
  const record = raw as Record<string, unknown>;
  for (const key of ["id", "provider", "providerSessionId", "cwd", "title"]) {
    if (typeof record[key] !== "string" || !record[key]) throw new Error(`${key} must be a non-empty string`);
  }
  if (typeof record.autoApprove !== "boolean") throw new Error("autoApprove must be boolean");
  if (typeof record.createdAt !== "number" || !Number.isFinite(record.createdAt)) {
    throw new Error("createdAt must be finite");
  }
}

/** Read one agent partition. Unreadable records are reported, never removed. */
export async function listBossCandidatesInPartition(
  directory: string,
  agent: string,
): Promise<BossCandidate[]> {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return [];
  }
  const candidates: BossCandidate[] = [];
  for (const entry of entries.filter((name) => name.endsWith(".json") && !name.startsWith(".")).sort()) {
    if (entry === CANONICAL_BOSS_POINTER_FILE) continue;
    const id = entry.slice(0, -".json".length);
    try {
      const parsed = JSON.parse(await readFile(join(directory, entry), "utf8"));
      requireRecordShape(parsed);
      const candidate = candidateFromRecord(agent, id, parsed);
      candidate.cwdAvailable = await directoryExists(candidate.cwd);
      candidates.push(candidate);
    } catch (error) {
      candidates.push({
        id,
        agent,
        provider: "",
        providerSessionId: "",
        cwd: "",
        title: "",
        autoApprove: false,
        startOptions: {},
        createdAt: 0,
        loadError: `${agent}/${entry}: ${error instanceof Error ? error.message : String(error)}`,
        cwdAvailable: false,
      });
    }
  }
  return candidates;
}

/**
 * Collect every persisted Boss session across agent partitions. Nothing is ever
 * deleted here: unreadable records come back with `loadError` so recovery can
 * report the exact reason.
 */
export async function listBossCandidates(root: string): Promise<BossCandidate[]> {
  let partitions: string[];
  try {
    partitions = await readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const candidates: BossCandidate[] = [];
  for (const partition of partitions.sort()) {
    if (partition.startsWith(".") || partition.endsWith(".json")) continue;
    candidates.push(...await listBossCandidatesInPartition(join(root, partition), partition));
  }
  return candidates;
}

export function bossCandidateReason(
  candidate: BossCandidate,
  configuredAgent: string,
): Exclude<BossSkipReason, "not-canonical"> | null {
  if (candidate.loadError) return "corrupt-record";
  if (candidate.agent !== configuredAgent) return "agent-mismatch";
  if (!candidate.cwdAvailable) return "cwd-unavailable";
  return null;
}

function unusableDetail(candidate: BossCandidate, configuredAgent: string): string {
  if (candidate.loadError) return candidate.loadError;
  if (candidate.agent !== configuredAgent) {
    return `${candidate.id} belongs to agent ${candidate.agent}, not ${configuredAgent}`;
  }
  return `${candidate.id} cannot load: working directory ${candidate.cwd} is unavailable`;
}

function skipped(
  candidates: BossCandidate[],
  configuredAgent: string,
  canonicalId: string | null,
): BossSkippedRecord[] {
  return candidates
    .filter((candidate) => candidate.id !== canonicalId)
    .map((candidate) => ({
      id: candidate.id,
      agent: candidate.agent,
      reason: bossCandidateReason(candidate, configuredAgent) ?? ("not-canonical" as const),
    }));
}

/**
 * Pure resolution: an existing pointer always wins, otherwise migration adopts
 * the exact routed session, then a single valid candidate. Anything else is a
 * visible blocked recovery that preserves every candidate.
 */
export function resolveCanonicalBoss(input: {
  pointer: CanonicalBossPointer | null;
  configuredAgent: string;
  routedSessionId: string | null;
  candidates: BossCandidate[];
}): CanonicalBossState {
  const { pointer, configuredAgent, routedSessionId, candidates } = input;
  const ordered = [...candidates].sort((a, b) => a.id.localeCompare(b.id));

  if (pointer) {
    if (pointer.agent !== configuredAgent) {
      return {
        status: "blocked",
        reason: "agent-mismatch",
        detail: `canonical Boss agent ${pointer.agent} is not the configured agent ${configuredAgent}`,
        pointer,
        candidates: ordered,
        skipped: skipped(ordered, configuredAgent, null),
      };
    }
    const referenced = ordered.find((candidate) => candidate.id === pointer.sessionId);
    if (!referenced) {
      return {
        status: "blocked",
        reason: "missing-record",
        detail: `canonical Boss session ${pointer.sessionId} is not in the session store`,
        pointer,
        candidates: ordered,
        skipped: skipped(ordered, configuredAgent, null),
      };
    }
    const reason = bossCandidateReason(referenced, configuredAgent);
    if (reason) {
      return {
        status: "blocked",
        reason,
        detail: unusableDetail(referenced, configuredAgent),
        pointer,
        candidates: ordered,
        skipped: skipped(ordered, configuredAgent, null),
      };
    }
    return {
      status: "canonical",
      pointer,
      session: referenced,
      skipped: skipped(ordered, configuredAgent, referenced.id),
    };
  }

  if (!configuredAgent) {
    if (!ordered.length) return { status: "none", skipped: [] };
    return {
      status: "blocked",
      reason: "agent-unconfigured",
      detail: "no Boss agent is configured",
      pointer: null,
      candidates: ordered,
      skipped: skipped(ordered, configuredAgent, null),
    };
  }

  const usable = ordered.filter((candidate) => bossCandidateReason(candidate, configuredAgent) === null);
  const unusable = ordered.filter((candidate) => bossCandidateReason(candidate, configuredAgent) !== null);

  if (routedSessionId) {
    const routed = ordered.find((candidate) => candidate.id === routedSessionId);
    if (routed) {
      const reason = bossCandidateReason(routed, configuredAgent);
      if (reason) {
        return {
          status: "blocked",
          reason,
          detail: unusableDetail(routed, configuredAgent),
          pointer: null,
          candidates: ordered,
          skipped: skipped(ordered, configuredAgent, null),
        };
      }
      return {
        status: "adopt",
        pointer: { version: 1, agent: configuredAgent, sessionId: routed.id },
        skipped: skipped(ordered, configuredAgent, routed.id),
      };
    }
  }

  if (usable.length === 1) {
    return {
      status: "adopt",
      pointer: { version: 1, agent: configuredAgent, sessionId: usable[0]!.id },
      skipped: skipped(ordered, configuredAgent, usable[0]!.id),
    };
  }
  if (usable.length > 1) {
    return {
      status: "blocked",
      reason: "ambiguous-candidates",
      detail: `${usable.length} persisted Boss sessions match agent ${configuredAgent}: ${usable.map((candidate) => candidate.id).join(", ")}`,
      pointer: null,
      candidates: ordered,
      skipped: skipped(ordered, configuredAgent, null),
    };
  }
  if (unusable.length) {
    const first = unusable[0]!;
    return {
      status: "blocked",
      reason: bossCandidateReason(first, configuredAgent)!,
      detail: unusableDetail(first, configuredAgent),
      pointer: null,
      candidates: ordered,
      skipped: skipped(ordered, configuredAgent, null),
    };
  }
  return { status: "none", skipped: [] };
}

/**
 * Deliberately non-prominent repair: repoint the canonical pointer at another
 * persisted candidate. Transcripts and candidate records are never removed.
 */
export async function repointCanonicalBoss(
  root: string,
  target: { agent: string; sessionId: string },
  options: { configuredAgent?: string } = {},
): Promise<
  | { ok: true; pointer: CanonicalBossPointer; session: BossCandidate }
  | { ok: false; error: string }
> {
  let pointer: CanonicalBossPointer;
  try {
    pointer = parseCanonicalBossPointer({ version: 1, agent: target.agent, sessionId: target.sessionId });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  const configuredAgent = options.configuredAgent ?? pointer.agent;
  // Repair must not be able to write a pointer the next start would reject.
  if (pointer.agent !== configuredAgent) {
    return { ok: false, error: `${pointer.agent} is not the configured agent ${configuredAgent}` };
  }
  const candidates = await listBossCandidates(root);
  const match = candidates.find(
    (candidate) => candidate.agent === pointer.agent && candidate.id === pointer.sessionId,
  );
  if (!match) return { ok: false, error: `no persisted Boss session ${pointer.agent}/${pointer.sessionId}` };
  const reason = bossCandidateReason(match, configuredAgent);
  if (reason) return { ok: false, error: unusableDetail(match, configuredAgent) };
  await writeCanonicalBossPointer(root, pointer);
  return { ok: true, pointer, session: match };
}
