import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { OptionValue } from "./types";

export interface PersistedAgentChatSession {
  id: string;
  provider: string;
  providerSessionId: string;
  cwd: string;
  title: string;
  autoApprove: boolean;
  startOptions: Record<string, OptionValue>;
  createdAt: number;
}

const sessionIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function assertSessionId(id: string) {
  if (!sessionIdPattern.test(id)) throw new Error(`invalid session id: ${id}`);
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value;
}

function parseRecord(value: unknown): PersistedAgentChatSession {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("session record must be an object");
  const raw = value as Record<string, unknown>;
  const id = requiredString(raw.id, "id");
  assertSessionId(id);
  const provider = requiredString(raw.provider, "provider");
  const providerSessionId = requiredString(raw.providerSessionId, "providerSessionId");
  const cwd = requiredString(raw.cwd, "cwd");
  if (!isAbsolute(cwd)) throw new Error("cwd must be absolute");
  const title = requiredString(raw.title, "title");
  if (typeof raw.autoApprove !== "boolean") throw new Error("autoApprove must be boolean");
  if (typeof raw.createdAt !== "number" || !Number.isFinite(raw.createdAt)) throw new Error("createdAt must be finite");
  if (!raw.startOptions || typeof raw.startOptions !== "object" || Array.isArray(raw.startOptions)) {
    throw new Error("startOptions must be an object");
  }
  const startOptions = Object.fromEntries(
    Object.entries(raw.startOptions).map(([key, option]) => {
      if (typeof option !== "string" && typeof option !== "boolean") {
        throw new Error(`startOptions.${key} must be a string or boolean`);
      }
      return [key, option];
    }),
  );
  return {
    id,
    provider,
    providerSessionId,
    cwd,
    title,
    autoApprove: raw.autoApprove,
    startOptions,
    createdAt: raw.createdAt,
  };
}

async function prepareDirectory(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
}

export async function writePersistedSession(directory: string, record: PersistedAgentChatSession) {
  const validated = parseRecord(record);
  await prepareDirectory(directory);
  const destination = join(directory, `${validated.id}.json`);
  const temporary = join(directory, `.${validated.id}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(validated)}\n`, { mode: 0o600 });
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function readPersistedSessions(
  directory: string,
): Promise<{ records: PersistedAgentChatSession[]; errors: string[] }> {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { records: [], errors: [] };
    throw error;
  }
  const records: PersistedAgentChatSession[] = [];
  const errors: string[] = [];
  for (const entry of entries.filter((name) => name.endsWith(".json")).sort()) {
    try {
      records.push(parseRecord(JSON.parse(await readFile(join(directory, entry), "utf8"))));
    } catch (error) {
      errors.push(`${entry}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { records, errors };
}

export async function deletePersistedSession(directory: string, id: string) {
  assertSessionId(id);
  await rm(join(directory, `${id}.json`), { force: true });
}
