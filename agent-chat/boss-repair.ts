#!/usr/bin/env bun
// Deliberately non-prominent Boss repair contract. It is not reachable from the
// normal Workbench UI: it lists the persisted Boss candidates and repoints the
// canonical pointer at one of them. It never deletes a transcript or a record.
//
//   bun agent-chat/boss-repair.ts list
//   bun agent-chat/boss-repair.ts repoint --agent <agent> --session <id>
//
// The sidecar base URL and token come from the app's state file, or from
// CMUX_AGENT_CHAT_BASE_URL for a manually launched server.

import { readFile } from "node:fs/promises";

function argValue(name: string): string | undefined {
  const eq = Bun.argv.find((arg) => arg.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const index = Bun.argv.indexOf(name);
  return index >= 0 ? Bun.argv[index + 1] : undefined;
}

export async function resolveBaseUrl(
  env: Record<string, string | undefined> = process.env,
  stateFilePath = argValue("--state-file") ?? env.CMUX_AGENT_CHAT_STATE_FILE ?? "",
): Promise<string> {
  const explicit = argValue("--base-url") ?? env.CMUX_AGENT_CHAT_BASE_URL ?? "";
  if (explicit) return explicit.replace(/\/$/, "");
  if (!stateFilePath) throw new Error("pass --base-url or --state-file");
  const state = JSON.parse(await readFile(stateFilePath, "utf8"));
  const token = argValue("--token") ?? env.CMUX_AGENT_CHAT_TOKEN ?? "";
  const prefix = token ? `/${encodeURIComponent(token)}` : "";
  return `http://127.0.0.1:${state.port}${prefix}`;
}

export async function runBossRepair(
  command: string,
  baseUrl: string,
  target: { agent: string; sessionId: string },
): Promise<{ status: number; body: unknown }> {
  if (command === "list") {
    const response = await fetch(`${baseUrl}/api/boss`);
    return { status: response.status, body: await response.json() };
  }
  if (command === "repoint") {
    if (!target.agent || !target.sessionId) throw new Error("repoint requires --agent and --session");
    const response = await fetch(`${baseUrl}/api/boss/repoint`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(target),
    });
    return { status: response.status, body: await response.json() };
  }
  throw new Error(`unknown command: ${command}`);
}

if (import.meta.main) {
  const command = Bun.argv[2] ?? "list";
  const baseUrl = await resolveBaseUrl();
  const result = await runBossRepair(command, baseUrl, {
    agent: argValue("--agent") ?? "",
    sessionId: argValue("--session") ?? "",
  });
  console.log(JSON.stringify(result.body, null, 2));
  process.exit(result.status >= 200 && result.status < 300 ? 0 : 1);
}
