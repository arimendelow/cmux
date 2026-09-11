import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { imageCapabilityOf, makeAcpAdapter, mergeAcpModelOption, userFacingAcpReplayText } from "../adapters/acp";
import type { AgentEvent, ProviderDef, SessionCtx } from "../types";

const reply = (message: any, result: unknown) => ({ jsonrpc: "2.0", id: message.id, result });
const update = (value: unknown) => ({ jsonrpc: "2.0", method: "session/update", params: { update: value } });

async function until<T>(read: () => T | undefined): Promise<T> {
  const deadline = performance.now() + 3_000;
  while (performance.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await Bun.sleep(5);
  }
  throw new Error("fake ACP did not deliver the expected protocol message");
}

// Reuse the existing stdio peer. Only its test-owned loopback controller chooses responses.
async function withPeer(
  respond: (message: any) => unknown[] | undefined | Promise<unknown[] | undefined>,
  run: (adapter: ReturnType<typeof makeAcpAdapter>, session: SessionCtx, requests: any[]) => Promise<void>,
  overrides: Partial<ProviderDef> = {},
) {
  const root = await mkdtemp(join(tmpdir(), "acp-protocol-"));
  const log = join(root, "processes.jsonl");
  const previous = { RECOVERY_TEST_URL: process.env.RECOVERY_TEST_URL, RECOVERY_TEST_PROCESS_LOG: process.env.RECOVERY_TEST_PROCESS_LOG };
  const requests: any[] = [];
  const controller = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(request) {
      expect(new URL(request.url).pathname).toBe("/acp");
      const message = await request.json();
      requests.push(message);
      const response = await respond(message);
      if (response) return Response.json(response);
      const result = message.method === "initialize"
        ? { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true } } }
        : message.method === "session/new" ? { sessionId: message.params?.sessionId ?? "peer-session" }
        : message.method === "session/prompt" ? { stopReason: "end_turn" } : {};
      return Response.json(message.method && message.id !== undefined ? [reply(message, result)] : []);
    },
  });
  process.env.RECOVERY_TEST_URL = `http://127.0.0.1:${controller.port}`;
  process.env.RECOVERY_TEST_PROCESS_LOG = log;
  const adapter = makeAcpAdapter({
    id: "protocol-acp", label: "Protocol ACP", adapter: "acp",
    cmd: [process.execPath, "--no-env-file", "--no-install", join(import.meta.dir, "fake-recovery-peer.ts")],
    ...overrides,
  });
  const session: SessionCtx = {
    id: "host-session", provider: "protocol-acp", cwd: root, title: "Protocol",
    autoApprove: false, startOptions: {}, status: "idle", events: [], internal: {},
    emit(event) { this.events.push(event); },
    setStatus(status) { this.status = status; },
  };
  try {
    await run(adapter, session, requests);
  } finally {
    const state = session.internal.acp as { proc: Bun.Subprocess } | undefined;
    const child = state?.proc ?? session.internal.acpStartingProc as Bun.Subprocess | undefined;
    adapter.dispose(session);
    controller.stop(true);
    await child?.exited;
    await Promise.resolve(session.internal.acpTurn).catch(() => {});
    const peers = await readFile(log, "utf8").then((text) => text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const peer of peers) {
      expect(peer.ppid).toBe(process.pid);
      expect(peer.role).toBe("acp");
      const alive = () => {
        try { process.kill(peer.pid, 0); return true; }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
      };
      const deadline = performance.now() + 2_000;
      while (alive() && performance.now() < deadline) await Bun.sleep(20);
      expect(alive()).toBe(false);
    }
    console.log("ACP fixture exit", JSON.stringify(peers));
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
}

test("ACP applies and refreshes config, mode, and model options through real requests", async () => {
  const options = [
    null, {}, { id: "ignored", type: "unsupported" },
    { id: "temperature", type: "select", currentValue: "warm", description: "Response style", options: [{ options: [{ value: "warm", name: "Warm" }, { value: "cool", label: "Cool", description: "Precise" }] }] },
    { id: "enabled", name: "Enabled", type: "boolean", currentValue: false },
    { id: "empty", type: "select" },
  ];
  await withPeer((message) => {
    if (message.method === "session/new") return [reply(message, {
      sessionId: "peer-session", configOptions: options,
      modes: { currentModeId: "build", availableModes: [{ id: "build" }, { id: "plan", name: "Plan", description: "Plan first" }] },
      models: { currentModelId: "model-1", availableModels: [{ modelId: "model-1", name: "First" }, { id: "model-2", description: "Second model" }] },
    })];
    if (message.method === "session/set_config_option") {
      if (message.params.configId === "temperature") return [{ jsonrpc: "2.0", id: message.id, error: { message: "Method not found" } }];
      return [reply(message, { configOptions: [{ id: "enabled", name: "Enabled", type: "boolean", currentValue: message.params.value }] })];
    }
  }, async (adapter, session, requests) => {
    session.startOptions = { temperature: "cool", enabled: true, mode: "plan", model: "model-2", ignored: "value", autoApprove: false };
    await adapter.send(session, "first");
    const methods = requests.filter((message) => message.method).map((message) => message.method);
    expect(methods).toEqual(["initialize", "session/new", "session/set_config_option", "session/set_config", "session/set_config_option", "session/set_mode", "session/set_model", "session/prompt"]);
    expect(requests.find((message) => message.method === "session/set_mode").params).toEqual({ sessionId: "peer-session", modeId: "plan" });
    expect(requests.find((message) => message.method === "session/set_model").params).toEqual({ sessionId: "peer-session", modelId: "model-2" });
    expect(requests.find((message) => message.method === "session/set_config").params).toEqual({ sessionId: "peer-session", configId: "temperature", value: "cool" });
    const latest = () => session.events.filter((event) => event.kind === "options").at(-1) as Extract<AgentEvent, { kind: "options" }>;
    expect(latest().options.find((option) => option.id === "temperature")).toMatchObject({
      value: "cool", label: "temperature", description: "Response style",
      choices: [{ value: "warm", label: "Warm" }, { value: "cool", label: "Cool", description: "Precise" }],
    });
    expect(latest().options.find((option) => option.id === "enabled")?.value).toBe(true);
    expect(latest().options.find((option) => option.id === "empty")?.choices).toEqual([]);
    expect(latest().options.some((option) => option.id === "ignored")).toBe(false);
    await adapter.send(session, "second");
    expect(requests.filter((message) => message.method === "session/set_mode")).toHaveLength(1);
    await expect(adapter.setOption(session, "missing", "value")).rejects.toThrow("unsupported protocol-acp option: missing");
    await expect(adapter.setOption(session, "autoApprove", "true")).rejects.toThrow("autoApprove must be boolean");
    await expect(adapter.setOption(session, "mode", true)).rejects.toThrow("mode must be a string");
    await expect(adapter.setOption(session, "model", true)).rejects.toThrow("model must be a string");
    await adapter.setOption(session, "autoApprove", true);
    await adapter.refreshOptions?.(session);
    expect(latest().options.find((option) => option.id === "autoApprove")?.value).toBe(true);
  });
});

test("ACP catalog probes normalize choices and commands and preserve honest failures", async () => {
  await withPeer((message) => message.method === "session/new" ? [
    reply(message, {
      sessionId: "catalog", configOptions: [{ id: "mode", type: "select", currentValue: "one", options: [{ value: "one" }] }],
      modes: { currentModeId: "ignored" }, models: {},
    }),
    update({ sessionUpdate: "available_commands_update", availableCommands: [{ name: "//inspect", description: "Inspect", source: "peer" }, { name: "" }, {}] }),
  ] : undefined, async (adapter, session, requests) => {
    const options = await adapter.listOptions?.(session.cwd);
    expect(options?.find((option) => option.id === "mode")).toMatchObject({ value: "one", choices: [{ value: "one", label: "one" }] });
    expect(options?.find((option) => option.id === "model")).toMatchObject({ value: "", choices: [] });
    expect(await adapter.listCommands?.(session.cwd)).toEqual([{ trigger: "/", commands: [{ name: "inspect", description: "Inspect", source: "peer" }] }]);
    expect(requests.filter((message) => message.method === "initialize")).toHaveLength(2);
  });
  await withPeer((message) => message.method === "initialize" ? [{ jsonrpc: "2.0", id: message.id, error: {} }] : undefined, async (adapter, session) => {
    await expect(adapter.listOptions?.(session.cwd)).rejects.toThrow("acp option catalog failed");
    await expect(adapter.listCommands?.(session.cwd)).rejects.toThrow("acp command catalog failed");
  });
  const empty = makeAcpAdapter({ id: "no-command", label: "No command", adapter: "acp", models: [{ value: "first", label: "First" }] });
  expect(await empty.listOptions?.(tmpdir())).toEqual(empty.capabilities?.options);
  expect(await empty.listCommands?.(tmpdir())).toEqual([{ trigger: "/", commands: [] }]);
  expect(empty.capabilities?.options[0].value).toBe("first");
  const exited = makeAcpAdapter({ id: "exited", label: "Exited", adapter: "acp", cmd: [process.execPath, "--no-env-file", "--no-install", "--eval", "process.exit(0)"] });
  expect(await exited.listOptions?.(tmpdir())).toEqual(exited.capabilities?.options);
  expect(await exited.listCommands?.(tmpdir())).toEqual([{ trigger: "/", commands: [] }]);
  expect(mergeAcpModelOption(undefined, [])).toMatchObject({ value: "", choices: [] });
  expect(mergeAcpModelOption(undefined, [{ value: "first", label: "First" }], "unlisted")).toMatchObject({
    value: "unlisted", choices: [{ value: "first", label: "First" }, { value: "unlisted", description: "Reported by the agent" }],
  });
});

test("ACP rejects invalid and duplicate permission responses without losing pending approval", async () => {
  const permission = (id: number, options: unknown) => ({
    jsonrpc: "2.0", id, method: "session/request_permission", params: { options },
  });
  await withPeer((message) => message.method === "session/prompt" ? [
    permission(51, [{ optionId: "yes", name: "Allow", kind: "allow_once" }, { optionId: 1, name: "bad", kind: "allow_once" }, null]),
    permission(52, [{ optionId: "no", name: "Deny", kind: "reject_once" }]),
    permission(53, null), permission(54, [{}]),
    reply(message, { stopReason: "end_turn" }),
  ] : undefined, async (adapter, session, requests) => {
    await expect(adapter.respondPermission?.(session, "absent", "yes")).rejects.toThrow("ACP provider is not ready");
    await adapter.send(session, "request approvals");
    const cards = session.events.filter((event) => event.kind === "permission-request") as Extract<AgentEvent, { kind: "permission-request" }>[];
    expect(cards).toHaveLength(2);
    expect(cards[0]).toMatchObject({ title: "Permission requested", options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }] });
    await expect(adapter.respondPermission?.(session, cards[0].requestId, "missing")).rejects.toThrow("permission option not found");
    const responses = await Promise.allSettled([
      adapter.respondPermission!(session, cards[0].requestId, "yes"),
      adapter.respondPermission!(session, cards[0].requestId, "yes"),
    ]);
    expect(responses.map((response) => response.status)).toEqual(["fulfilled", "rejected"]);
    expect((responses[1] as PromiseRejectedResult).reason.message).toContain("already in progress");
    await adapter.stop(session);
    await until(() => requests.find((message) => message.method === "session/cancel"));
    expect(requests.find((message) => message.id === 51 && message.result)?.result).toEqual({ outcome: { outcome: "selected", optionId: "yes" } });
    for (const id of [52, 53, 54]) {
      expect(requests.find((message) => message.id === id && message.result)?.result).toEqual({ outcome: { outcome: "cancelled" } });
    }
    expect(session.events.filter((event) => event.kind === "status" && event.text === "permission request had no valid options")).toHaveLength(2);
  });
  await withPeer((message) => message.method === "session/prompt" ? [
    permission(61, [{ optionId: "always", name: "Always", kind: "allow_always" }, { optionId: "once", name: "Once", kind: "allow_once" }]),
    permission(62, [{ optionId: "once", name: "Once", kind: "allow_once" }]),
    permission(63, [{ optionId: "deny", name: "Deny", kind: "reject_once" }]),
    reply(message, {}),
  ] : undefined, async (adapter, session, requests) => {
    session.startOptions.autoApprove = true;
    await adapter.send(session, "approved policy");
    await until(() => requests.find((message) => message.id === 63 && message.result));
    expect(requests.find((message) => message.id === 61 && message.result)?.result.outcome.optionId).toBe("always");
    expect(requests.find((message) => message.id === 62 && message.result)?.result.outcome.optionId).toBe("once");
    expect(requests.find((message) => message.id === 63 && message.result)?.result.outcome).toEqual({ outcome: "cancelled" });
    expect(session.events.some((event) => event.kind === "permission-request")).toBe(false);
  });
});

test("ACP validates elicitation schemas and typed content before writing a correlated response", async () => {
  const schema = {
    type: "object", required: ["choice", "count", 3],
    properties: {
      choice: { type: "string", enum: ["one"], title: " Choice ", description: "Choose one" },
      count: { type: "integer", default: 1 },
      amount: { type: "number", default: null },
      enabled: { type: "boolean", default: false },
      optional: { type: "string", title: " " },
    },
  };
  const form = (id: number, requestedSchema: unknown, mode = "form") => ({ jsonrpc: "2.0", id, method: "elicitation/create", params: { mode, requestedSchema } });
  await withPeer((message) => message.method === "session/prompt" ? [
    form(70, schema), form(71, schema), form(72, schema),
    ...[null, [], 3, {}, { type: "object", properties: [] }, { type: "object", properties: { x: null } }, { type: "object", properties: { x: [] } }, { type: "object", properties: { x: { type: "array" } } }, { type: "object", properties: { x: { type: "string", enum: [1] } } }]
      .map((invalid, index) => form(80 + index, invalid)),
    form(90, schema, "url"),
    reply(message, { stopReason: "end_turn" }),
  ] : undefined, async (adapter, session, requests) => {
    await expect(adapter.respondElicitation?.(session, "absent", "cancel")).rejects.toThrow("ACP provider is not ready");
    await adapter.send(session, "form");
    const cards = session.events.filter((event) => event.kind === "elicitation-request") as Extract<AgentEvent, { kind: "elicitation-request" }>[];
    expect(cards).toHaveLength(3);
    expect(cards[0].message).toBe("Information requested");
    expect(cards[0].fields.find((field) => field.name === "count")).toMatchObject({ title: "count", type: "integer", required: true, defaultValue: 1 });
    expect(cards[0].fields.find((field) => field.name === "optional")?.title).toBe("optional");
    for (const [content, error] of [
      [undefined, "is required: choice"], [{ choice: "" }, "is required: choice"],
      [{ choice: true, count: 1 }, "invalid value: choice"], [{ choice: "two", count: 1 }, "invalid option: choice"],
      [{ choice: "one", count: 1.5 }, "invalid value: count"], [{ choice: "one", count: Infinity }, "invalid value: count"],
      [{ choice: "one", count: 1, enabled: "yes" }, "invalid value: enabled"],
      [{ choice: "one", count: 1, amount: NaN }, "invalid value: amount"],
    ] as const) {
      await expect(adapter.respondElicitation?.(session, cards[0].requestId, "accept", content as any)).rejects.toThrow(error);
    }
    const content = { choice: "one", count: 1, amount: 1.5, enabled: false, optional: "", extra: "not in schema" };
    const responses = await Promise.allSettled([
      adapter.respondElicitation!(session, cards[0].requestId, "accept", content),
      adapter.respondElicitation!(session, cards[0].requestId, "accept", content),
    ]);
    expect(responses.map((response) => response.status)).toEqual(["fulfilled", "rejected"]);
    expect((responses[1] as PromiseRejectedResult).reason.message).toContain("already in progress");
    await adapter.respondElicitation?.(session, cards[1].requestId, "decline");
    await adapter.stop(session);
    await until(() => requests.find((message) => message.method === "session/cancel"));
    expect(requests.find((message) => message.id === 70 && message.result)?.result).toEqual({ action: "accept", content: { choice: "one", count: 1, amount: 1.5, enabled: false } });
    expect(requests.find((message) => message.id === 71 && message.result)?.result).toEqual({ action: "decline" });
    expect(requests.find((message) => message.id === 72 && message.result)?.result).toEqual({ action: "cancel" });
    expect(requests.filter((message) => message.error?.code === -32602)).toHaveLength(10);
  });
});

test("ACP dispositions preserve useful updates without treating malformed notifications as a turn", async () => {
  await withPeer((message) => message.method === "session/prompt" ? [
    null, false, { jsonrpc: "1.0", method: "session/update" }, { id: 999, result: {} },
    { method: "session/update" },
    ...[
      { sessionUpdate: "user_message_chunk" }, { sessionUpdate: "user_message_chunk", content: { text: "question" } },
      { sessionUpdate: "agent_message_chunk" }, { sessionUpdate: "agent_thought_chunk" },
      { sessionUpdate: "agent_thought_chunk", content: { text: "thinking" } },
      { sessionUpdate: "tool_call", kind: "read" }, { sessionUpdate: "tool_call", rawInput: { file: "owned.txt" } },
      { sessionUpdate: "tool_call_update", status: "pending" },
      { sessionUpdate: "tool_call_update", status: "failed", content: [{ text: "failed" }, null, {}] },
      { sessionUpdate: "tool_call_update", status: "completed", content: null },
      { sessionUpdate: "plan", entries: [null, {}, { content: " " }, { content: "  valid  ", status: 3 }] },
      { sessionUpdate: "plan", entries: null },
      { sessionUpdate: "available_commands_update", availableCommands: null },
      { sessionUpdate: "current_mode_update" }, { sessionUpdate: "current_mode_update", currentModeId: "plan" },
      { sessionUpdate: "config_option_update" },
      { sessionUpdate: "config_options_update", configOptions: [{ id: "model", type: "select" }], models: {}, modes: {} },
      { sessionUpdate: "session_info_update" }, { sessionUpdate: "usage_update" }, { sessionUpdate: 3 },
    ].map(update),
    { jsonrpc: "2.0", id: 100, method: "fs/read_text_file" },
    { jsonrpc: "2.0", method: "unknown-notification" },
    reply(message, {}),
  ] : undefined, async (adapter, session, requests) => {
    await adapter.send(session, "updates");
    expect(session.events).toContainEqual({ kind: "user", text: "question" });
    expect(session.events).toContainEqual({ kind: "thinking", text: "thinking" });
    expect(session.events).toContainEqual(expect.objectContaining({ kind: "tool-start", name: "read" }));
    expect(session.events).toContainEqual(expect.objectContaining({ kind: "tool-start", name: "tool", detail: '{"file":"owned.txt"}' }));
    expect(session.events).toContainEqual(expect.objectContaining({ kind: "tool-end", ok: false, detail: "failed" }));
    expect(session.events).toContainEqual({ kind: "plan", entries: [{ content: "valid" }] });
    expect(session.events).toContainEqual({ kind: "plan", entries: [] });
    expect(session.events.filter((event) => event.kind === "done")).toHaveLength(1);
    await until(() => requests.find((message) => message.id === 100 && message.error));
    expect(requests.find((message) => message.id === 100 && message.error)?.error.code).toBe(-32601);
  });
  expect(userFacingAcpReplayText("plain\n\n\ntext")).toBe("plain\n\ntext");
  expect(userFacingAcpReplayText("[attachments]\nnot an attachment")).toBe("[attachments]\nnot an attachment");
  expect(userFacingAcpReplayText("[attachments]\n- attachment:x | image")).toBe("[attachments]\n- attachment:x | image");
  expect(userFacingAcpReplayText("[attachments]\n- attachment:x | file |  | text/plain")).toBe("[Attachment: attachment]");
});

test("ACP initialization is shared and cancelled admission can be retried on the same peer", async () => {
  await withPeer(() => undefined, async (adapter, session, requests) => {
    expect(imageCapabilityOf(session)).toBe("unknown");
    await adapter.preparePromptAttachments?.(session, []);
    expect(requests).toEqual([]);
    await Promise.all([adapter.warmup?.(session, { initializeOnly: true }), adapter.warmup?.(session, { initializeOnly: true })]);
    expect(requests.map((message) => message.method)).toEqual(["initialize"]);
    expect(imageCapabilityOf(session)).toBe("supported");
    session.internal.productId = "ouro-workbench-v1";
    let admitted = 0;
    await expect(adapter.sendWithAdmission?.(session, "cancelled", 1, [], () => { admitted++; }, () => false)).rejects.toThrow("agent startup cancelled");
    expect(admitted).toBe(0);
    expect(session.events.some((event) => event.kind === "done" || event.kind === "error")).toBe(false);
    await Promise.all([adapter.send(session, "one"), adapter.send(session, "two")]);
    expect(requests.filter((message) => message.method === "session/new")).toHaveLength(1);
    expect(requests.find((message) => message.method === "session/new").params).toEqual({ sessionId: "host-session", cwd: session.cwd, mcpServers: [] });
    expect(requests.filter((message) => message.method === "session/prompt")).toHaveLength(2);
    expect(session.status).toBe("idle");
    expect(session.events.filter((event) => event.kind === "done")).toHaveLength(2);
  }, { role: "boss" });
});

test("ACP does not replace a transiently failed load or accept a mismatched Workbench session", async () => {
  await withPeer((message) => message.method === "session/load"
    ? [{ jsonrpc: "2.0", id: message.id, error: { message: "temporary transport failure" } }]
    : undefined, async (adapter, session, requests) => {
    session.internal.acpResumeSessionId = "saved";
    await expect(adapter.warmup?.(session)).rejects.toThrow("temporary transport failure");
    expect(session.internal.acpResumeSessionId).toBe("saved");
    expect(requests.some((message) => message.method === "session/new")).toBe(false);
  });
  await withPeer((message) => message.method === "session/new" ? [reply(message, { sessionId: "other" })] : undefined, async (adapter, session) => {
    session.internal.productId = "ouro-workbench-v1";
    await expect(adapter.warmup?.(session)).rejects.toThrow("mismatched Workbench session id");
    expect(session.internal.acpResumeSessionId).toBeUndefined();
  });
});
