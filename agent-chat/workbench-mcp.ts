#!/usr/bin/env bun
import { createInterface } from "node:readline";

type MCPRequest = {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
};

type NativeCall = (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected an object");
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) throw new Error(`${name} must contain 1-${maxLength} characters`);
  return trimmed;
}

function requireExactKeys(value: Record<string, unknown>, allowed: string[]): void {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  if (unexpected) throw new Error(`unsupported argument: ${unexpected}`);
}

function actionArguments(name: string, raw: unknown): Record<string, unknown> {
  const args = object(raw);
  requireExactKeys(
    args,
    name === "workbench_focus"
      ? ["request_id", "workspace_id", "surface_id"]
      : ["request_id", "workspace_id", "surface_id", "summary"],
  );
  const requestId = requiredString(args.request_id, "request_id", 128);
  if (!REQUEST_ID.test(requestId)) throw new Error("request_id contains unsupported characters");
  const workspaceId = requiredString(args.workspace_id, "workspace_id", 36);
  if (!UUID.test(workspaceId)) throw new Error("workspace_id must be a UUID");
  const surfaceId = args.surface_id === undefined
    ? undefined
    : requiredString(args.surface_id, "surface_id", 36);
  if (surfaceId !== undefined && !UUID.test(surfaceId)) throw new Error("surface_id must be a UUID");
  if (name === "workbench_focus" && !surfaceId) throw new Error("surface_id is required");
  if (name === "workbench_flag_for_review") {
    const summary = requiredString(args.summary, "summary", 500);
    return {
      request_id: requestId,
      workspace_id: workspaceId,
      ...(surfaceId ? { surface_id: surfaceId } : {}),
      summary,
    };
  }
  return { request_id: requestId, workspace_id: workspaceId, surface_id: surfaceId };
}

function toolResult(id: unknown, value: unknown, isError = false) {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    result: {
      content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
      isError,
    },
  };
}

export function workbenchToolDefinitions() {
  const targetProperties = {
    request_id: { type: "string", description: "Stable idempotency key for this action." },
    workspace_id: { type: "string", description: "Exact cmux workspace UUID." },
    surface_id: { type: "string", description: "Exact cmux surface UUID." },
  };
  return [
    {
      name: "workbench_focus",
      description: "Focus and visibly flash one exact local Workbench surface.",
      inputSchema: {
        type: "object",
        properties: targetProperties,
        required: ["request_id", "workspace_id", "surface_id"],
        additionalProperties: false,
      },
    },
    {
      name: "workbench_flag_for_review",
      description: "Create one idempotent native Workbench review notification for Ari.",
      inputSchema: {
        type: "object",
        properties: {
          ...targetProperties,
          summary: { type: "string", description: "Concise reason Ari is needed, at most 500 characters." },
        },
        required: ["request_id", "workspace_id", "summary"],
        additionalProperties: false,
      },
    },
  ];
}

export async function handleWorkbenchMCPRequest(request: MCPRequest, call: NativeCall) {
  const id = request.id ?? null;
  if (request.jsonrpc !== "2.0" || typeof request.method !== "string") {
    return { jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid Request" } };
  }
  if (request.method === "notifications/initialized") return null;
  if (request.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "ouro-workbench-v1", version: "1" },
      },
    };
  }
  if (request.method === "tools/list") {
    return { jsonrpc: "2.0", id, result: { tools: workbenchToolDefinitions() } };
  }
  if (request.method !== "tools/call") {
    return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${request.method}` } };
  }

  try {
    const params = object(request.params);
    const name = requiredString(params.name, "name", 80);
    if (name !== "workbench_focus" && name !== "workbench_flag_for_review") {
      throw new Error(`unknown tool: ${name}`);
    }
    const args = actionArguments(name, params.arguments);
    const method = name === "workbench_focus" ? "workbench.focus" : "workbench.flag_for_review";
    return toolResult(id, await call(method, args));
  } catch (error) {
    return toolResult(id, error instanceof Error ? error.message : String(error), true);
  }
}

export async function callWorkbenchNative(
  method: string,
  params: Record<string, unknown>,
  environment: Record<string, string | undefined> = process.env,
): Promise<Record<string, unknown>> {
  const cli = environment.CMUX_BUNDLED_CLI_PATH;
  const socket = environment.CMUX_SOCKET_PATH;
  if (!cli || !socket) throw new Error("Workbench control coordinates are unavailable");
  const child = Bun.spawn([cli, "--socket", socket, "rpc", method, JSON.stringify(params)], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...environment, CMUX_SOCKET_PATH: socket },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(stderr.trim() || `cmux exited ${exitCode}`);
  const parsed = JSON.parse(stdout);
  return object(parsed);
}

export async function runWorkbenchMCP(
  lines: AsyncIterable<string>,
  write: (text: string) => unknown,
  call: NativeCall = callWorkbenchNative,
) {
  for await (const line of lines) {
    if (!line.trim()) continue;
    let response;
    try {
      response = await handleWorkbenchMCPRequest(JSON.parse(line), call);
    } catch {
      response = { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } };
    }
    if (response) write(`${JSON.stringify(response)}\n`);
  }
}

if (import.meta.main) {
  await runWorkbenchMCP(
    createInterface({ input: process.stdin, crlfDelay: Infinity }),
    (text) => process.stdout.write(text),
  );
}
