import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  callWorkbenchNative,
  handleWorkbenchMCPRequest,
  runWorkbenchMCP,
  workbenchToolDefinitions,
} from "../workbench-mcp";

type InspectedResponse = {
  error?: { code: number };
  result?: {
    serverInfo?: { name: string };
    tools?: unknown[];
    isError?: boolean;
  };
} | null;

function inspectResponse(
  response: Awaited<ReturnType<typeof handleWorkbenchMCPRequest>>,
): InspectedResponse {
  return response;
}

test("Workbench MCP exposes bounded inspection and safe local actions", () => {
  expect(workbenchToolDefinitions().map((tool) => tool.name)).toEqual([
    "workbench_list",
    "workbench_inspect",
    "workbench_focus",
    "workbench_send_guidance",
    "workbench_interrupt",
    "workbench_stop",
    "workbench_resume",
    "workbench_flag_for_review",
  ]);
});

test("Workbench MCP handles its complete protocol surface", async () => {
  const call = async () => ({});
  expect(inspectResponse(await handleWorkbenchMCPRequest({}, call))?.error?.code).toBe(-32600);
  expect(await handleWorkbenchMCPRequest({
    jsonrpc: "2.0",
    method: "notifications/initialized",
  }, call)).toBeNull();
  expect(inspectResponse(await handleWorkbenchMCPRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
  }, call))?.result?.serverInfo?.name).toBe("ouro-workbench-v1");
  expect(inspectResponse(await handleWorkbenchMCPRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
  }, call))?.result?.tools).toHaveLength(8);
  expect(inspectResponse(await handleWorkbenchMCPRequest({
    jsonrpc: "2.0",
    id: 3,
    method: "unknown",
  }, call))?.error?.code).toBe(-32601);
  expect(inspectResponse(await handleWorkbenchMCPRequest({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "unknown", arguments: {} },
  }, call))?.result?.isError).toBe(true);
});

test("Workbench MCP maps validated tools to exact native action requests", async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const call = async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params });
    return { request_id: params.request_id, status: "completed" };
  };
  const workspaceId = "11111111-1111-4111-8111-111111111111";
  const surfaceId = "22222222-2222-4222-8222-222222222222";

  const list = await handleWorkbenchMCPRequest({
    jsonrpc: "2.0",
    id: 0,
    method: "tools/call",
    params: {
      name: "workbench_list",
      arguments: {},
    },
  }, call);
  expect(inspectResponse(list)?.result?.isError).toBe(false);

  const inspect = await handleWorkbenchMCPRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "workbench_inspect",
      arguments: { workspace_id: workspaceId, surface_id: surfaceId },
    },
  }, call);
  expect(inspectResponse(inspect)?.result?.isError).toBe(false);

  const focus = await handleWorkbenchMCPRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "workbench_focus",
      arguments: { request_id: "focus-1", workspace_id: workspaceId, surface_id: surfaceId },
    },
  }, call);
  expect(inspectResponse(focus)?.result?.isError).toBe(false);

  const flag = await handleWorkbenchMCPRequest({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "workbench_flag_for_review",
      arguments: {
        request_id: "review-1",
        workspace_id: workspaceId,
        surface_id: surfaceId,
        summary: "Ari needs to choose a rollout ring.",
      },
    },
  }, call);
  expect(inspectResponse(flag)?.result?.isError).toBe(false);

  const guidance = await handleWorkbenchMCPRequest({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: "workbench_send_guidance",
      arguments: {
        request_id: "guidance-1",
        workspace_id: workspaceId,
        surface_id: surfaceId,
        session_id: "copilot-session",
        expected_source_revision: "revision-1",
        expected_input_epoch: 4,
        text: "Use the shared helper and continue.",
      },
    },
  }, call);
  expect(inspectResponse(guidance)?.result?.isError).toBe(false);

  for (const [id, name] of [
    [5, "workbench_interrupt"],
    [6, "workbench_stop"],
    [7, "workbench_resume"],
  ] as const) {
    const response = await handleWorkbenchMCPRequest({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: {
        name,
        arguments: {
          request_id: `${name}-1`,
          workspace_id: workspaceId,
          surface_id: surfaceId,
          session_id: "copilot-session",
          expected_source_revision: "revision-1",
          expected_input_epoch: 4,
        },
      },
    }, call);
    expect(inspectResponse(response)?.result?.isError).toBe(false);
  }
  expect(calls).toEqual([
    {
      method: "workbench.list",
      params: {},
    },
    {
      method: "workbench.inspect",
      params: { workspace_id: workspaceId, surface_id: surfaceId },
    },
    {
      method: "workbench.focus",
      params: { request_id: "focus-1", workspace_id: workspaceId, surface_id: surfaceId },
    },
    {
      method: "workbench.flag_for_review",
      params: {
        request_id: "review-1",
        workspace_id: workspaceId,
        surface_id: surfaceId,
        summary: "Ari needs to choose a rollout ring.",
      },
    },
    {
      method: "workbench.send_guidance",
      params: {
        request_id: "guidance-1",
        workspace_id: workspaceId,
        surface_id: surfaceId,
        session_id: "copilot-session",
        expected_source_revision: "revision-1",
        expected_input_epoch: 4,
        text: "Use the shared helper and continue.",
      },
    },
    {
      method: "workbench.interrupt",
      params: {
        request_id: "workbench_interrupt-1",
        workspace_id: workspaceId,
        surface_id: surfaceId,
        session_id: "copilot-session",
        expected_source_revision: "revision-1",
        expected_input_epoch: 4,
      },
    },
    {
      method: "workbench.stop",
      params: {
        request_id: "workbench_stop-1",
        workspace_id: workspaceId,
        surface_id: surfaceId,
        session_id: "copilot-session",
        expected_source_revision: "revision-1",
        expected_input_epoch: 4,
      },
    },
    {
      method: "workbench.resume",
      params: {
        request_id: "workbench_resume-1",
        workspace_id: workspaceId,
        surface_id: surfaceId,
        session_id: "copilot-session",
        expected_source_revision: "revision-1",
        expected_input_epoch: 4,
      },
    },
  ]);
});

test("Workbench MCP rejects malformed action requests before native dispatch", async () => {
  let calls = 0;
  const response = await handleWorkbenchMCPRequest({
    jsonrpc: "2.0",
    id: "bad",
    method: "tools/call",
    params: {
      name: "workbench_flag_for_review",
      arguments: {
        request_id: "review-1",
        workspace_id: "not-a-uuid",
        summary: "",
        unexpected: true,
      },
    },
  }, async () => {
    calls += 1;
    return {};
  });

  expect(inspectResponse(response)?.result?.isError).toBe(true);
  const guidance = await handleWorkbenchMCPRequest({
    jsonrpc: "2.0",
    id: "bad-guidance",
    method: "tools/call",
    params: {
      name: "workbench_send_guidance",
      arguments: {
        request_id: "guidance-1",
        workspace_id: "11111111-1111-4111-8111-111111111111",
        surface_id: "22222222-2222-4222-8222-222222222222",
        session_id: "copilot-session",
        expected_source_revision: "revision-1",
        expected_input_epoch: -1,
        text: "line one\nline two",
      },
    },
  }, async () => {
    calls += 1;
    return {};
  });
  expect(inspectResponse(guidance)?.result?.isError).toBe(true);
  expect(calls).toBe(0);
});

test("Workbench MCP executable calls the selected cmux socket", async () => {
  const root = await mkdtemp(join(tmpdir(), "workbench-mcp-"));
  const cli = join(root, "cmux");
  const log = join(root, "args.log");
  await Bun.write(cli, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$WORKBENCH_MCP_ARG_LOG"\nprintf '{"status":"completed"}\\n'\n`);
  await chmod(cli, 0o755);
  const process = Bun.spawn([join(import.meta.dir, "../OuroWorkbenchMCP")], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...globalThis.process.env,
      BUN_BIN: Bun.which("bun") ?? "bun",
      CMUX_BUNDLED_CLI_PATH: cli,
      CMUX_SOCKET_PATH: "/tmp/workbench.sock",
      WORKBENCH_MCP_ARG_LOG: log,
    },
  });
  process.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "workbench_focus",
      arguments: {
        request_id: "focus-e2e",
        workspace_id: "11111111-1111-4111-8111-111111111111",
        surface_id: "22222222-2222-4222-8222-222222222222",
      },
    },
  })}\n`);
  process.stdin.end();
  const [stdout, stderr, status] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);

  expect(status).toBe(0);
  expect(stderr).toBe("");
  expect(JSON.parse(stdout).result.isError).toBe(false);
  expect(await readFile(log, "utf8")).toContain("--socket /tmp/workbench.sock rpc workbench.focus");
  await rm(root, { recursive: true, force: true });
});

test("Workbench MCP loop translates malformed input", async () => {
  async function* input() {
    yield "";
    yield "not-json";
    yield JSON.stringify({ jsonrpc: "2.0", id: 1, method: "notifications/initialized" });
  }
  const output: string[] = [];
  await runWorkbenchMCP(input(), (line) => output.push(line), async () => ({}));
  expect(output.map((line) => JSON.parse(line))).toEqual([
    { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
  ]);
});

test("Workbench native caller reports missing coordinates and CLI failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "workbench-mcp-failure-"));
  try {
    const cli = join(root, "cmux");
    await Bun.write(cli, "#!/bin/sh\nprintf 'native failed\\n' >&2\nexit 9\n");
    await chmod(cli, 0o755);
    await expect(callWorkbenchNative("workbench.focus", {}, {})).rejects.toThrow(
      "Workbench control coordinates are unavailable",
    );
    await expect(callWorkbenchNative("workbench.focus", {}, {
      CMUX_BUNDLED_CLI_PATH: cli,
      CMUX_SOCKET_PATH: "/tmp/workbench.sock",
    })).rejects.toThrow("native failed");

    await Bun.write(cli, "#!/bin/sh\nprintf 'not-json\\n'\n");
    await expect(callWorkbenchNative("workbench.focus", {}, {
      CMUX_BUNDLED_CLI_PATH: cli,
      CMUX_SOCKET_PATH: "/tmp/workbench.sock",
    })).rejects.toThrow();

    await Bun.write(cli, "#!/bin/sh\nexit 7\n");
    await expect(callWorkbenchNative("workbench.focus", {}, {
      CMUX_BUNDLED_CLI_PATH: cli,
      CMUX_SOCKET_PATH: "/tmp/workbench.sock",
    })).rejects.toThrow("cmux exited 7");

    await Bun.write(cli, "#!/bin/sh\nprintf '{\"status\":\"completed\"}\\n'\n");
    expect(await callWorkbenchNative("workbench.focus", {}, {
      CMUX_BUNDLED_CLI_PATH: cli,
      CMUX_SOCKET_PATH: "/tmp/workbench.sock",
    })).toEqual({ status: "completed" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
