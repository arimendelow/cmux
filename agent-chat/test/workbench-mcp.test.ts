import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  callWorkbenchNative,
  handleWorkbenchMCPRequest,
  runWorkbenchMCP,
  watchWorkbenchRestore,
  workbenchRestoreFacts,
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
      arguments: { after_sequence: 12 },
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
      params: { after_sequence: 12 },
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
  const badList = await handleWorkbenchMCPRequest({
    jsonrpc: "2.0",
    id: "bad-list",
    method: "tools/call",
    params: {
      name: "workbench_list",
      arguments: { after_sequence: -1 },
    },
  }, async () => {
    calls += 1;
    return {};
  });
  expect(inspectResponse(badList)?.result?.isError).toBe(true);
  expect(calls).toBe(0);
});

test("Workbench MCP executable calls the selected cmux socket", async () => {
  const root = await mkdtemp(join(tmpdir(), "workbench-mcp-"));
  const cli = join(root, "cmux");
  const log = join(root, "args.log");
  await Bun.write(cli, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$WORKBENCH_MCP_ARG_LOG"\nprintf '{"status":"completed","pid":%s,"ppid":%s}\\n' "$$" "$PPID"\n`);
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
  const native = JSON.parse(JSON.parse(stdout).result.content[0].text);
  expect(native.ppid).toBe(process.pid);
  expect(() => globalThis.process.kill(native.pid, 0)).toThrow();
  expect(() => globalThis.process.kill(process.pid, 0)).toThrow();
  console.log("MCP fixture exit", JSON.stringify([
    { pid: process.pid, ppid: globalThis.process.pid, role: "packaged-mcp" },
    { pid: native.pid, ppid: native.ppid, role: "native-shell" },
  ]));
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

test("Workbench tools reject malformed values before invoking the native boundary", async () => {
  const workspace = "11111111-1111-4111-8111-111111111111";
  const surface = "22222222-2222-4222-8222-222222222222";
  const target = { request_id: "request-1", workspace_id: workspace, surface_id: surface };
  const guarded = { ...target, session_id: "session-1", expected_source_revision: "revision-1", expected_input_epoch: 0 };
  const invalid: Array<[string, unknown, string]> = [
    ["workbench_list", null, "expected an object"],
    ["workbench_list", [], "expected an object"],
    ["workbench_list", "args", "expected an object"],
    ["workbench_list", { after_sequence: "1" }, "after_sequence must be a non-negative integer"],
    ["workbench_list", { after_sequence: 0.5 }, "after_sequence must be a non-negative integer"],
    ["workbench_list", { unexpected: true }, "unsupported argument: unexpected"],
    ["workbench_inspect", { workspace_id: "window:1", surface_id: surface }, "workspace_id must be a UUID"],
    ["workbench_inspect", { workspace_id: workspace, surface_id: "surface:1" }, "surface_id must be a UUID"],
    ["workbench_focus", { ...target, request_id: 3 }, "request_id must be a string"],
    ["workbench_focus", { ...target, request_id: "" }, "request_id must contain 1-128 characters"],
    ["workbench_focus", { ...target, request_id: "a".repeat(129) }, "request_id must contain 1-128 characters"],
    ["workbench_focus", { ...target, request_id: "bad request" }, "request_id contains unsupported characters"],
    ["workbench_focus", { ...target, workspace_id: "window:1" }, "workspace_id must be a UUID"],
    ["workbench_focus", { ...target, surface_id: "surface:1" }, "surface_id must be a UUID"],
    ["workbench_focus", { request_id: "request-1", workspace_id: workspace }, "surface_id is required"],
    ["workbench_flag_for_review", { ...target, summary: "" }, "summary must contain 1-500 characters"],
    ["workbench_send_guidance", { ...guarded, text: "line one\nline two" }, "text must be a single line"],
    ["workbench_send_guidance", { ...guarded, text: "nul\u0000text" }, "text must be a single line"],
    ["workbench_send_guidance", { ...guarded, text: "hello", expected_input_epoch: "0" }, "expected_input_epoch must be a non-negative integer"],
    ["workbench_send_guidance", { ...guarded, text: "hello", expected_input_epoch: 1.5 }, "expected_input_epoch must be a non-negative integer"],
    ["workbench_send_guidance", { ...guarded, text: "hello", expected_input_epoch: -1 }, "expected_input_epoch must be a non-negative integer"],
  ];
  const calls: unknown[] = [];
  for (const [name, args, error] of invalid) {
    const response = await handleWorkbenchMCPRequest({
      jsonrpc: "2.0", id: "invalid", method: "tools/call", params: { name, arguments: args },
    }, async (method, params) => { calls.push({ method, params }); return {}; });
    expect(response).toEqual({
      jsonrpc: "2.0", id: "invalid",
      result: { content: [{ type: "text", text: error }], isError: true },
    });
  }
  expect(calls).toEqual([]);
  const args = { request_id: " review-1 ", workspace_id: workspace, summary: " Needs review " };
  const response = await handleWorkbenchMCPRequest({
    jsonrpc: "2.0", method: "tools/call", params: { name: "workbench_flag_for_review", arguments: args },
  }, async (method, params) => {
    expect(method).toBe("workbench.flag_for_review");
    expect(params).toEqual({ request_id: "review-1", workspace_id: workspace, summary: "Needs review" });
    return { status: "completed" };
  });
  expect(response).toEqual({
    jsonrpc: "2.0", id: null,
    result: { content: [{ type: "text", text: '{"status":"completed"}' }], isError: false },
  });
  await handleWorkbenchMCPRequest({
    jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "workbench_list", arguments: {} },
  }, async (method, params) => {
    expect(method).toBe("workbench.list");
    expect(params).toEqual({});
    return {};
  });
});

const appId = "11111111-1111-4111-8111-111111111111";
function restoreSnapshot(state = "running", restoreState = "ready") {
  return {
    topology: {
      app_instance_id: appId, restore_state: restoreState, revision: 7,
      windows: [{
        window_id: "22222222-2222-4222-8222-222222222222",
        workspaces: [{
          workspace_id: "33333333-3333-4333-8333-333333333333",
          panes: [{
            pane_id: "44444444-4444-4444-8444-444444444444",
            surfaces: [{
              surface_id: "55555555-5555-4555-8555-555555555555",
              resume: { state, blocked_reason: null as string | null },
            }],
          }],
        }],
      }],
    },
  };
}

test("native restore facts retain exact topology identities and unresolved reasons", () => {
  for (const state of ["none", "running", "ended", "resuming", "manual_resume_available", "resume_available", "waiting_for_supervisor", "blocked_unverified"]) {
    const facts = restoreSnapshot(state);
    const blocked = ["manual_resume_available", "resume_available", "waiting_for_supervisor", "blocked_unverified"].includes(state);
    const expected = blocked ? [{
      window_id: "22222222-2222-4222-8222-222222222222",
      workspace_id: "33333333-3333-4333-8333-333333333333",
      pane_id: "44444444-4444-4444-8444-444444444444",
      surface_id: "55555555-5555-4555-8555-555555555555",
      reason: state,
    }] : [];
    expect(workbenchRestoreFacts(facts, appId)).toEqual({ facts, unresolved: expected, ready: state !== "resuming", revision: 7 });
  }
  const facts = restoreSnapshot("manual_resume_available", "restoring");
  facts.topology.windows[0].workspaces[0].panes[0].surfaces[0].resume.blocked_reason = "auto_resume_disabled";
  const result = workbenchRestoreFacts(facts, appId);
  expect(result.facts).toBe(facts);
  expect(result.unresolved[0].reason).toBe("auto_resume_disabled");
  expect(result.ready).toBe(false);
  expect(workbenchRestoreFacts(restoreSnapshot("none", "pending"), appId).ready).toBe(false);
});

test("native restore facts fail closed on invalid identity, readiness, shape, and namespace values", () => {
  for (const patch of [
    { app_instance_id: "other" }, { restore_state: "unknown" }, { revision: 0.5 }, { revision: -1 },
  ]) {
    const facts = restoreSnapshot();
    Object.assign(facts.topology, patch);
    expect(() => workbenchRestoreFacts(facts, appId)).toThrow("invalid native restore identity or readiness");
  }
  expect(() => workbenchRestoreFacts({ topology: null }, appId)).toThrow("expected an object");
  const wrongWindows = restoreSnapshot();
  (wrongWindows.topology as any).windows = {};
  expect(() => workbenchRestoreFacts(wrongWindows, appId)).toThrow("invalid native topology");
  const wrongWindow = restoreSnapshot();
  (wrongWindow.topology as any).windows = [null];
  expect(() => workbenchRestoreFacts(wrongWindow, appId)).toThrow("expected an object");
  expect(() => workbenchRestoreFacts(restoreSnapshot("new-state"), appId)).toThrow("unsupported native resume state");
  for (const field of ["window_id", "workspace_id", "pane_id", "surface_id"]) {
    const facts = restoreSnapshot("blocked_unverified");
    const window = facts.topology.windows[0];
    const workspace = window.workspaces[0];
    const pane = workspace.panes[0];
    const surface = pane.surfaces[0];
    const owner = { window_id: window, workspace_id: workspace, pane_id: pane, surface_id: surface }[field];
    (owner as any)[field] = `${field}:1`;
    expect(() => workbenchRestoreFacts(facts, appId)).toThrow("invalid native topology ID");
    (owner as any)[field] = null;
    expect(() => workbenchRestoreFacts(facts, appId)).toThrow("invalid native topology ID");
  }
});

test("restore watching consumes the exact fake CLI cursor and rejects invalid stream frames", async () => {
  await expect(Promise.resolve().then(() => watchWorkbenchRestore(7, () => {}, () => {}, {})))
    .rejects.toThrow("Workbench control coordinates are unavailable");
  for (const frames of [
    [{ type: "ack", resume: { gap: true } }, { type: "heartbeat" }, { type: "event", seq: 8 }, { type: "event", seq: 8 }, { type: "event", seq: 6 }],
    [{ type: "ack" }, { type: "event", seq: "8" }],
    ["not-json"],
  ]) {
    const root = await mkdtemp(join(tmpdir(), "workbench-events-"));
    const log = join(root, "processes.jsonl");
    const requests: string[][] = [];
    const controller = Bun.serve({
      port: 0, hostname: "127.0.0.1",
      async fetch(request) {
        expect(new URL(request.url).pathname).toBe("/events");
        requests.push(await request.json());
        return new Response(frames.map((frame) => typeof frame === "string" ? frame : JSON.stringify(frame)).join("\n") + "\n");
      },
    });
    let changed = 0;
    let failures = 0;
    const failed = Promise.withResolvers<void>();
    const environment = {
      ...process.env, CMUX_BUNDLED_CLI_PATH: join(import.meta.dir, "fake-recovery-peer.ts"),
      CMUX_SOCKET_PATH: join(root, "native.sock"),
      RECOVERY_TEST_URL: `http://127.0.0.1:${controller.port}`,
      RECOVERY_TEST_PROCESS_LOG: log,
    };
    const stop = watchWorkbenchRestore(7, () => { changed++; }, () => { failures++; failed.resolve(); }, environment);
    try {
      await failed.promise;
      expect(failures).toBe(1);
      expect(changed).toBe(frames.length === 5 ? 2 : 0);
      expect(requests).toEqual([[
        "--socket", join(root, "native.sock"), "events", "--after", "7",
        "--category", "app", "--category", "agent", "--no-heartbeats",
      ]]);
    } finally {
      stop();
      controller.stop(true);
      const peers = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      for (const peer of peers) {
        expect(peer.ppid).toBe(process.pid);
        expect(peer.role).toBe("events");
        const alive = () => {
          try { process.kill(peer.pid, 0); return true; }
          catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
        };
        const deadline = performance.now() + 2_000;
        while (alive() && performance.now() < deadline) await Bun.sleep(20);
        expect(alive()).toBe(false);
      }
      console.log("MCP fixture exit", JSON.stringify(peers));
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("the MCP line loop uses its real native caller when no replacement is supplied", async () => {
  const root = await mkdtemp(join(tmpdir(), "workbench-native-loop-"));
  const log = join(root, "processes.jsonl");
  const requests: unknown[] = [];
  const controller = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(request) {
      expect(new URL(request.url).pathname).toBe("/native");
      requests.push(await request.json());
      return Response.json({ status: "completed" });
    },
  });
  const environment = {
    CMUX_BUNDLED_CLI_PATH: join(import.meta.dir, "fake-recovery-peer.ts"),
    CMUX_SOCKET_PATH: join(root, "native.sock"),
    RECOVERY_TEST_URL: `http://127.0.0.1:${controller.port}`,
    RECOVERY_TEST_PROCESS_LOG: log,
  };
  const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);
  try {
    async function* input() {
      yield "  ";
      yield "null";
      yield JSON.stringify({ jsonrpc: "2.0", id: 17, method: "tools/call", params: { name: "workbench_list", arguments: { after_sequence: 2 } } });
    }
    const output: string[] = [];
    await runWorkbenchMCP(input(), (line) => output.push(line));
    expect(requests).toEqual([{ method: "workbench.list", params: { after_sequence: 2 } }]);
    expect(output.map((line) => JSON.parse(line))).toEqual([
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
      { jsonrpc: "2.0", id: 17, result: { content: [{ type: "text", text: '{"status":"completed"}' }], isError: false } },
    ]);
    const peers = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(peers).toHaveLength(1);
    expect(peers[0].ppid).toBe(process.pid);
    expect(peers[0].role).toBe("rpc");
    expect(() => process.kill(peers[0].pid, 0)).toThrow();
    console.log("MCP fixture exit", JSON.stringify(peers));
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    controller.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});
