import type {
  Adapter,
  CommandEntry,
  ElicitationAction,
  ElicitationField,
  OptionChoice,
  OptionValue,
  PermissionOption,
  ProviderDef,
  SessionCtx,
  SessionOption,
} from "../types";
import { readLines, tryParse, truncate } from "./lines";
import { prettifyModelLabel } from "./model-label";

// Generic Agent Client Protocol (https://agentclientprotocol.com) client over
// stdio NDJSON JSON-RPC. One adapter covers every ACP-speaking agent:
// `opencode acp`, `gemini --experimental-acp`, `claude-code-acp`, goose, ...
export function makeAcpAdapter(def: ProviderDef): Adapter {
  const fallbackOptions = acpFallbackOptions(def);
  const adapter: Adapter = {
    capabilities: {
      triggers: ["/"],
      options: fallbackOptions,
    },
    async send(sess, prompt, generation?: number) {
      // ACP has no mid-turn steer and most agents reject overlapping
      // session/prompt calls, so serialize sends: a prompt sent while a turn
      // is in flight runs after that turn resolves.
      sess.setStatus("running");
      const prev = (sess.internal.acpTurn as Promise<void> | undefined) ?? Promise.resolve();
      const turn = prev.then(async () => {
        try {
          const st = await ensureAcp(sess, def);
          await applyInitialOptions(sess, st, def);
          const res = await st.request("session/prompt", {
            sessionId: st.acpSessionId,
            prompt: [{ type: "text", text: prompt }],
          });
          sess.emit({ kind: "done", stats: res?.stopReason ? `stop: ${res.stopReason}` : undefined, generation } as any);
        } catch (err) {
          if (/\bcancelled\b/i.test(String(err instanceof Error ? err.message : err))) {
            sess.emit({ kind: "status", text: "Stopped" });
          } else {
            sess.emit({ kind: "error", message: truncate(String(err), 400) });
          }
          sess.emit({ kind: "done", generation } as any);
        }
        if (sess.internal.acpTurn === turn) sess.setStatus("idle");
      });
      sess.internal.acpTurn = turn;
      await turn;
    },
    stop(sess) {
      const st = sess.internal.acp as AcpState | undefined;
      if (st?.acpSessionId) {
        cancelPendingPermissions(sess, st);
        st.notify("session/cancel", { sessionId: st.acpSessionId });
        return;
      }
      const startingProc = sess.internal.acpStartingProc as AcpState["proc"] | undefined;
      if (startingProc?.exitCode === null && !startingProc.killed) {
        sess.internal.acpStartupCancelled = true;
        sess.internal.userStopped = true;
        startingProc.kill();
      }
    },
    dispose(sess) {
      const st = sess.internal.acp as AcpState | undefined;
      const startingProc = sess.internal.acpStartingProc as AcpState["proc"] | undefined;
      sess.internal.acp = undefined;
      sess.internal.acpStarting = undefined;
      sess.internal.acpStartingProc = undefined;
      st?.proc.kill();
      startingProc?.kill();
    },
    async respondPermission(sess, requestId, optionId) {
      const st = sess.internal.acp as AcpState | undefined;
      if (!st) throw new Error(`${def.id} ACP provider is not ready`);
      const pending = st.pendingPermissions.get(requestId);
      if (!pending) throw new Error(`permission request not found: ${requestId}`);
      const option = pending.options.find((candidate) => candidate.optionId === optionId);
      if (!option) throw new Error(`permission option not found: ${optionId}`);
      st.pendingPermissions.delete(requestId);
      st.writeMsg({
        jsonrpc: "2.0",
        id: pending.rpcId,
        result: { outcome: { outcome: "selected", optionId } },
      });
      sess.emit({ kind: "permission-resolved", requestId, optionId });
    },
    async respondElicitation(sess, requestId, action, content) {
      const st = sess.internal.acp as AcpState | undefined;
      if (!st) throw new Error(`${def.id} ACP provider is not ready`);
      const pending = st.pendingElicitations.get(requestId);
      if (!pending) throw new Error(`elicitation request not found: ${requestId}`);
      const validatedContent = action === "accept"
        ? validateElicitationContent(pending.fields, content ?? {})
        : undefined;
      st.pendingElicitations.delete(requestId);
      st.writeMsg({
        jsonrpc: "2.0",
        id: pending.rpcId,
        result: {
          action,
          ...(validatedContent ? { content: validatedContent } : {}),
        },
      });
      sess.emit({ kind: "elicitation-resolved", requestId, action });
    },
    async setOption(sess, id, value) {
      const st = await ensureAcp(sess, def);
      await setAcpOption(sess, st, def, id, value);
    },
    async refreshOptions(sess) {
      const st = await ensureAcp(sess, def);
      ingestAcpOptions(st, {}, def, String(st.options.find((option) => option.id === "model")?.value ?? ""));
      emitAcpState(sess, st);
    },
    async listOptions(cwd) {
      if (def.probeCatalogs === false) return fallbackOptions;
      return withAcpLocalOptions(await fetchAcpOptions(def, cwd, fallbackOptions), false);
    },
    async listCommands(cwd) {
      if (def.probeCatalogs === false) return [{ trigger: "/", commands: [] }];
      return [{ trigger: "/", commands: await fetchAcpCommands(def, cwd) }];
    },
  };
  return adapter;
}

interface AcpState {
  proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  acpSessionId: string;
  request(method: string, params: unknown): Promise<any>;
  notify(method: string, params: unknown): void;
  options: SessionOption[];
  sources: Map<string, "config" | "mode" | "model" | "spawnModel">;
  autoApprove: boolean;
  commands: CommandEntry[];
  initialApplied: boolean;
  pendingPermissions: Map<string, { rpcId: unknown; options: PermissionOption[] }>;
  pendingElicitations: Map<string, { rpcId: unknown; fields: ElicitationField[] }>;
  toolTitles: Map<string, string>;
  requestNamespace: string;
  suppressSessionReplay: boolean;
  unsupportedUpdates: Set<string>;
  writeMsg(msg: unknown): void;
}

const MAX_UNSUPPORTED_UPDATE_NAMES = 16;

function acpFallbackOptions(def: ProviderDef): SessionOption[] {
  const model = def.models?.length
    ? { id: "model", label: "Model", kind: "select" as const, value: def.defaultModel ?? def.models[0]!.value, choices: def.models }
    : { id: "model", label: "Model", kind: "select" as const, value: "", disabled: true, description: "Loads at start" };
  return [
    model,
    {
      id: "mode",
      label: "Mode",
      kind: "select",
      value: "build",
      choices: [
        { value: "build", label: "build" },
        { value: "plan", label: "plan" },
      ],
    },
    { id: "autoApprove", label: "Auto-approve", kind: "toggle", value: false, role: "approval" },
  ];
}

function effectiveSpawnModel(def: ProviderDef, options: Record<string, OptionValue>): string {
  return typeof options.model === "string" && def.models?.some((m) => m.value === options.model)
    ? options.model
    : def.defaultModel ?? def.models?.[0]?.value ?? "";
}

function commandForSession(def: ProviderDef, options: Record<string, OptionValue>): string[] {
  const cmd = [...(def.cmd ?? [])];
  if (def.models?.length) {
    cmd.push("--model", effectiveSpawnModel(def, options));
  }
  return cmd;
}

async function ensureAcp(sess: SessionCtx, def: ProviderDef): Promise<AcpState> {
  const existing = sess.internal.acp as AcpState | undefined;
  if (existing && existing.proc.exitCode === null && !existing.proc.killed) return existing;
  const starting = sess.internal.acpStarting as Promise<AcpState> | undefined;
  if (starting) return starting;

  const displayName = def.role === "boss" ? "Boss" : def.label;
  sess.emit({
    kind: "connection",
    state: "starting",
    title: `Starting ${displayName}`,
    message: "Connecting to the local ACP session.",
  });
  const promise = startAcp(sess, def).then((state) => {
    sess.emit({ kind: "connection", state: "ready", title: `${displayName} connected` });
    return state;
  }).catch((error) => {
    sess.emit({ kind: "connection", state: "failed", title: `${displayName} connection failed` });
    throw error;
  }).finally(() => {
    if (sess.internal.acpStarting === promise) sess.internal.acpStarting = undefined;
    sess.internal.acpStartingProc = undefined;
  });
  sess.internal.acpStarting = promise;
  return promise;
}

function isUnavailableSessionLoad(error: unknown): boolean {
  const message = String(error instanceof Error ? error.message : error);
  return /method not found|session.*(?:not found|does not exist|unknown|invalid|expired)/i.test(message);
}

async function startAcp(sess: SessionCtx, def: ProviderDef): Promise<AcpState> {
  const spawnModel = effectiveSpawnModel(def, sess.startOptions);
  const cmd = commandForSession(def, sess.startOptions);
  const autoApprove = typeof sess.startOptions.autoApprove === "boolean" ? sess.startOptions.autoApprove : sess.autoApprove;
  if (autoApprove && def.autoApproveArgs) cmd.push(...def.autoApproveArgs);
  const proc = Bun.spawn(cmd, {
    cwd: sess.cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
  sess.internal.acpStartingProc = proc;

  let nextId = 1;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  const writeMsg = (msg: unknown) => {
    proc.stdin.write(JSON.stringify(msg) + "\n");
    proc.stdin.flush();
  };
  const request = (method: string, params: unknown) =>
    new Promise<any>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      writeMsg({ jsonrpc: "2.0", id, method, params });
    });
  const notify = (method: string, params: unknown) =>
    writeMsg({ jsonrpc: "2.0", method, params });

  const st: AcpState = {
    proc,
    acpSessionId: "",
    request,
    notify,
    options: [],
    sources: new Map(),
    autoApprove,
    commands: [],
    initialApplied: false,
    pendingPermissions: new Map(),
    pendingElicitations: new Map(),
    toolTitles: new Map(),
    requestNamespace: crypto.randomUUID().slice(0, 8),
    suppressSessionReplay: false,
    unsupportedUpdates: new Set(),
    writeMsg,
  };

  readLines(proc.stdout, (line) => {
    const msg = tryParse(line);
    if (!msg) return;
    if (msg.jsonrpc !== undefined && msg.jsonrpc !== "2.0") return;
    if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        msg.error ? p.reject(new Error(msg.error.message ?? "acp error")) : p.resolve(msg.result);
      }
      return;
    }
    if (msg.method) handleAgentMessage(sess, st, def, msg, writeMsg);
  }, () => {
    for (const p of pending.values()) p.reject(new Error(`${def.id} acp process exited`));
    pending.clear();
    for (const requestId of st.pendingPermissions.keys()) {
      sess.emit({ kind: "permission-resolved", requestId, optionId: "cancelled" });
    }
    for (const requestId of st.pendingElicitations.keys()) {
      sess.emit({ kind: "elicitation-resolved", requestId, action: "cancel" });
    }
    st.pendingPermissions.clear();
    st.pendingElicitations.clear();
    if (sess.internal.acp && (sess.internal.acp as AcpState).proc === proc) {
      sess.internal.acp = undefined;
    }
  });
  readLines(proc.stderr, () => {});

  // An agent that starts but never answers initialize/session/new would leave
  // the session stuck in "running" with nothing to cancel; killing the process
  // closes stdout, which rejects the pending startup requests.
  let startupTimedOut = false;
  const startupTimeoutMs = def.startupTimeoutMs ?? 30_000;
  const startupTimer = setTimeout(() => {
    startupTimedOut = true;
    proc.kill();
  }, startupTimeoutMs);
  try {
    await request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        elicitation: { form: {} },
      },
    });
    const resumeSessionId = typeof sess.internal.acpResumeSessionId === "string"
      ? sess.internal.acpResumeSessionId
      : "";
    let resumed = false;
    let respawned = false;
    let sessionState: any;
    if (resumeSessionId) {
      try {
        const restoredFromDisk = sess.internal.restoredFromDisk === true;
        st.suppressSessionReplay = !restoredFromDisk && sess.events.some((event) =>
          ["user", "assistant", "delta", "thinking", "tool-start", "tool-end", "plan"].includes(event.kind)
        );
        try {
          sessionState = await request("session/load", { sessionId: resumeSessionId, cwd: sess.cwd, mcpServers: [] });
        } finally {
          st.suppressSessionReplay = false;
        }
        resumed = true;
      } catch (error) {
        if (!isUnavailableSessionLoad(error)) throw error;
        delete sess.internal.acpResumeSessionId;
        delete sess.internal.persistedProviderSessionId;
        await sess.invalidatePersistedSession?.();
        sessionState = await request("session/new", { cwd: sess.cwd, mcpServers: [] });
        respawned = true;
      }

    } else {
      sessionState = await request("session/new", { cwd: sess.cwd, mcpServers: [] });
    }
    st.acpSessionId = resumed ? resumeSessionId : sessionState.sessionId;
    sess.internal.acpResumeSessionId = st.acpSessionId;
    ingestAcpOptions(st, sessionState ?? {}, def, spawnModel);
    sess.internal.acp = st;
    if (resumed) {
      const restoredFromDisk = sess.internal.restoredFromDisk === true;
      delete sess.internal.restoredFromDisk;
      const hostName = sess.internal.productId === "ouro-workbench-v1" ? "Workbench" : "Agent Chat";
      sess.emit({
        kind: "recovery",
        mode: "resumed",
        title: "Conversation resumed",
        message: restoredFromDisk
          ? `Loaded the existing provider session after ${hostName} restarted.`
          : "Reconnected to the existing provider session.",
      });
    } else if (respawned) {
      delete sess.internal.restoredFromDisk;
      sess.emit({
        kind: "recovery",
        mode: "respawned",
        title: "Started a fresh conversation",
        message: "The previous provider session could not be loaded.",
      });
    }
    sess.emit({ kind: "meta", providerSessionId: st.acpSessionId });
    emitAcpState(sess, st);
    return st;
  } catch (err) {
    proc.kill();
    if (sess.internal.acpStartupCancelled === true) {
      delete sess.internal.acpStartupCancelled;
      throw new Error(`${def.id} ACP startup cancelled`);
    }
    throw startupTimedOut ? new Error(`${def.id} did not finish ACP startup within ${startupTimeoutMs}ms`) : err;
  } finally {
    clearTimeout(startupTimer);
  }
}

async function applyInitialOptions(sess: SessionCtx, st: AcpState, def: ProviderDef) {
  if (st.initialApplied) return;
  st.initialApplied = true;
  for (const [id, value] of Object.entries(sess.startOptions)) {
    if (id === "autoApprove" || (st.sources.has(id) && !(id === "model" && st.sources.get(id) === "spawnModel"))) {
      await setAcpOption(sess, st, def, id, value);
    }
  }
}

async function setAcpOption(sess: SessionCtx, st: AcpState, def: ProviderDef, id: string, value: OptionValue) {
  if (id === "autoApprove") {
    if (typeof value !== "boolean") throw new Error("autoApprove must be boolean");
    st.autoApprove = value;
    emitAcpState(sess, st);
    return;
  }
  const source = st.sources.get(id);
  if (!source) throw new Error(`unsupported ${sess.provider} option: ${id}`);
  if (source === "config") {
    const params = { sessionId: st.acpSessionId, configId: id, value };
    let res: any;
    try {
      res = await st.request("session/set_config_option", params);
    } catch (err) {
      if (!String(err).includes("Method not found")) throw err;
      res = await st.request("session/set_config", params);
    }
    if (res?.configOptions) ingestAcpOptions(st, res, def);
    else updateLocalOption(st, id, value);
  } else if (source === "mode") {
    if (typeof value !== "string") throw new Error("mode must be a string");
    await st.request("session/set_mode", { sessionId: st.acpSessionId, modeId: value });
    updateLocalOption(st, id, value);
  } else if (source === "model") {
    if (typeof value !== "string") throw new Error("model must be a string");
    await st.request("session/set_model", { sessionId: st.acpSessionId, modelId: value });
    updateLocalOption(st, id, value);
  } else if (source === "spawnModel") {
    if (typeof value !== "string") throw new Error("model must be a string");
    sess.startOptions.model = value;
    updateLocalOption(st, id, value);
    emitAcpState(sess, st);
    const proc = st.proc;
    if ((sess.internal.acp as AcpState | undefined) === st) sess.internal.acp = undefined;
    delete sess.internal.acpResumeSessionId;
    delete sess.internal.persistedProviderSessionId;
    await sess.invalidatePersistedSession?.();
    proc.kill();
    await ensureAcp(sess, def);
    sess.emit({ kind: "status", text: "model changed, conversation restarted" });
    return;
  }
  emitAcpState(sess, st);
}

function ingestAcpOptions(st: AcpState, payload: any, def?: ProviderDef, spawnModel?: string) {
  const options = new Map(st.options.map((o) => [o.id, o] as const));
  const sources = new Map(st.sources);
  for (const opt of payload.configOptions ?? []) {
    const mapped = configOption(opt);
    if (!mapped) continue;
    options.set(mapped.id, mapped);
    sources.set(mapped.id, "config");
  }
  if (payload.modes && sources.get("mode") !== "config") {
    const modes = payload.modes;
    options.set("mode", {
      id: "mode",
      label: "Mode",
      kind: "select",
      value: String(modes.currentModeId ?? ""),
      choices: (modes.availableModes ?? []).map((m: any) => ({
        value: String(m.id),
        label: String(m.name ?? m.id),
        description: m.description ? String(m.description) : undefined,
      })),
    });
    sources.set("mode", "mode");
  }
  if (payload.models && sources.get("model") !== "config") {
    const models = payload.models;
    options.set("model", {
      id: "model",
      label: "Model",
      kind: "select",
      value: String(models.currentModelId ?? ""),
      choices: (models.availableModels ?? []).map((m: any) => ({
        value: String(m.modelId ?? m.id),
        label: prettifyModelLabel(String(m.name ?? m.modelId ?? m.id)),
        description: m.description ? String(m.description) : undefined,
      })),
    });
    sources.set("model", "model");
  }
  if (def?.models?.length) {
    options.set("model", mergeAcpModelOption(options.get("model"), def.models, def.defaultModel, spawnModel));
    sources.set("model", "spawnModel");
  }
  st.options = [...options.values()];
  st.sources = sources;
}

export function mergeAcpModelOption(
  existing: SessionOption | undefined,
  curated: OptionChoice[],
  defaultModel?: string,
  spawnModel?: string,
): SessionOption {
  const binary = new Map((existing?.choices ?? []).map((choice) => [choice.value, choice]));
  const choices: OptionChoice[] = curated.map((choice) => {
    const reported = binary.get(choice.value);
    binary.delete(choice.value);
    return { ...reported, ...choice };
  });
  choices.push(...binary.values());
  const value = String(spawnModel || existing?.value || defaultModel || choices[0]?.value || "");
  if (value && !choices.some((choice) => choice.value === value)) {
    choices.push({ value, label: prettifyModelLabel(value), description: "Reported by the agent" });
  }
  return { id: "model", label: "Model", kind: "select", value, choices };
}

function configOption(opt: any): SessionOption | null {
  if (!opt?.id) return null;
  if (opt.type === "select") {
    return {
      id: String(opt.id),
      label: String(opt.name ?? opt.id),
      kind: "select",
      value: String(opt.currentValue ?? ""),
      choices: flattenChoices(opt.options),
      description: opt.description ? String(opt.description) : undefined,
    };
  }
  if (opt.type === "boolean") {
    return {
      id: String(opt.id),
      label: String(opt.name ?? opt.id),
      kind: "toggle",
      value: Boolean(opt.currentValue),
      description: opt.description ? String(opt.description) : undefined,
    };
  }
  return null;
}

function flattenChoices(raw: any): OptionChoice[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (Array.isArray(item.options)) return flattenChoices(item.options);
    return [{
      value: String(item.value),
      label: String(item.name ?? item.label ?? item.value),
      description: item.description ? String(item.description) : undefined,
    }];
  });
}

function updateLocalOption(st: AcpState, id: string, value: OptionValue) {
  st.options = st.options.map((o) => o.id === id ? { ...o, value } : o);
}

function emitAcpState(sess: SessionCtx, st: AcpState) {
  sess.emit({ kind: "options", options: withAcpLocalOptions(st.options, st.autoApprove) });
  if (st.commands.length) sess.emit({ kind: "commands", trigger: "/", commands: st.commands });
}

function withAcpLocalOptions(options: SessionOption[], autoApprove: boolean): SessionOption[] {
  return [
    ...options.filter((o) => o.id !== "autoApprove"),
    { id: "autoApprove", label: "Auto-approve", kind: "toggle", value: autoApprove, role: "approval" },
  ];
}

function cancelPendingPermissions(sess: SessionCtx, st: AcpState) {
  for (const [requestId, pending] of st.pendingPermissions) {
    st.writeMsg({
      jsonrpc: "2.0",
      id: pending.rpcId,
      result: { outcome: { outcome: "cancelled" } },
    });
    sess.emit({ kind: "permission-resolved", requestId, optionId: "cancelled" });
  }
  st.pendingPermissions.clear();
  for (const [requestId, pending] of st.pendingElicitations) {
    st.writeMsg({ jsonrpc: "2.0", id: pending.rpcId, result: { action: "cancel" } });
    sess.emit({ kind: "elicitation-resolved", requestId, action: "cancel" });
  }
  st.pendingElicitations.clear();
}

function permissionOptions(value: unknown): PermissionOption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((option) => {
    const optionId = typeof option?.optionId === "string" ? option.optionId : "";
    const name = typeof option?.name === "string" ? option.name : "";
    const kind = typeof option?.kind === "string" ? option.kind : "";
    return optionId && name && kind ? [{ optionId, name, kind }] : [];
  });
}

function elicitationFields(schema: unknown): ElicitationField[] {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) throw new Error("elicitation schema must be an object");
  const raw = schema as Record<string, unknown>;
  if (raw.type !== "object" || !raw.properties || typeof raw.properties !== "object" || Array.isArray(raw.properties)) {
    throw new Error("elicitation schema must describe object properties");
  }
  const required = new Set(Array.isArray(raw.required) ? raw.required.filter((name): name is string => typeof name === "string") : []);
  return Object.entries(raw.properties).map(([name, value]) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`elicitation field ${name} is invalid`);
    const field = value as Record<string, unknown>;
    const type = field.type;
    if (type !== "string" && type !== "boolean" && type !== "number" && type !== "integer") {
      throw new Error(`elicitation field ${name} has unsupported type`);
    }
    const options = Array.isArray(field.enum)
      ? field.enum.map((option) => {
        if (typeof option !== "string") throw new Error(`elicitation field ${name} has a non-string enum option`);
        return option;
      })
      : undefined;
    const defaultValue = typeof field.default === "string" || typeof field.default === "boolean" || typeof field.default === "number"
      ? field.default
      : undefined;
    return {
      name,
      type,
      title: typeof field.title === "string" && field.title.trim() ? field.title : name,
      description: typeof field.description === "string" ? field.description : undefined,
      required: required.has(name),
      options,
      defaultValue,
    };
  });
}

function validateElicitationContent(
  fields: ElicitationField[],
  content: Record<string, string | boolean | number>,
): Record<string, string | boolean | number> {
  const result: Record<string, string | boolean | number> = {};
  for (const field of fields) {
    const value = content[field.name];
    if (value === undefined || value === "") {
      if (field.required) throw new Error(`elicitation field is required: ${field.name}`);
      continue;
    }
    const validType = field.type === "boolean"
      ? typeof value === "boolean"
      : field.type === "string"
        ? typeof value === "string"
        : typeof value === "number" && Number.isFinite(value) && (field.type !== "integer" || Number.isInteger(value));
    if (!validType) throw new Error(`elicitation field has invalid value: ${field.name}`);
    if (field.options && (typeof value !== "string" || !field.options.includes(value))) {
      throw new Error(`elicitation field has invalid option: ${field.name}`);
    }
    result[field.name] = value;
  }
  return result;
}

// Notifications and reverse requests from the agent.
function handleAgentMessage(sess: SessionCtx, st: AcpState, def: ProviderDef, msg: any, writeMsg: (m: unknown) => void) {
  if (msg.method === "session/update") {
    const u = msg.params?.update;
    if (!u) return;
    if (st.suppressSessionReplay && [
      "user_message_chunk",
      "agent_message_chunk",
      "agent_thought_chunk",
      "tool_call",
      "tool_call_update",
      "plan",
    ].includes(u.sessionUpdate)) return;
    switch (u.sessionUpdate) {
      case "user_message_chunk":
        if (u.content?.text) sess.emit({ kind: "user", text: u.content.text });
        break;
      case "agent_message_chunk":
        if (u.content?.text) sess.emit({ kind: "delta", text: u.content.text });
        break;
      case "agent_thought_chunk":
        if (u.content?.text) sess.emit({ kind: "thinking", text: u.content.text });
        break;
      case "tool_call":
        if (u.toolCallId && u.title) st.toolTitles.set(String(u.toolCallId), String(u.title));
        sess.emit({
          kind: "tool-start",
          toolId: u.toolCallId,
          name: u.title ?? u.kind ?? "tool",
          detail: truncate(JSON.stringify(u.rawInput ?? {})),
        });
        break;
      case "tool_call_update":
        if (u.status === "completed" || u.status === "failed") {
          sess.emit({
            kind: "tool-end",
            toolId: u.toolCallId,
            ok: u.status === "completed",
            detail: truncate(contentText(u.content), 400),
          });
          st.toolTitles.delete(String(u.toolCallId));
        }
        break;
      case "plan":
        sess.emit({ kind: "plan", entries: normalizePlanEntries(u.entries) });
        break;
      case "available_commands_update":
        st.commands = normalizeCommands(u.availableCommands);
        sess.emit({ kind: "commands", trigger: "/", commands: st.commands });
        break;
      case "current_mode_update":
        if (u.currentModeId) {
          updateLocalOption(st, "mode", String(u.currentModeId));
          emitAcpState(sess, st);
        }
        break;
      case "config_option_update":
      case "config_options_update":
        if (u.configOptions) {
          ingestAcpOptions(st, u, def);
          emitAcpState(sess, st);
        }
        break;
      case "session_info_update":
      case "usage_update":
        break;
      default: {
        const name = typeof u.sessionUpdate === "string" ? truncate(u.sessionUpdate, 80) : "";
        if (name && !st.unsupportedUpdates.has(name) && st.unsupportedUpdates.size < MAX_UNSUPPORTED_UPDATE_NAMES) {
          st.unsupportedUpdates.add(name);
          sess.emit({ kind: "status", text: `Unsupported ACP session update: ${name}` });
        }
        break;
      }
    }
    if (u.configOptions || u.modes || u.models) {
      ingestAcpOptions(st, u, def);
      emitAcpState(sess, st);
    }
    return;
  }
  // Reverse request: must answer or the agent hangs.
  if (msg.id != null && msg.method === "elicitation/create") {
    if (msg.params?.mode !== "form") {
      writeMsg({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "unsupported elicitation mode" } });
      return;
    }
    try {
      const fields = elicitationFields(msg.params?.requestedSchema);
      const requestId = `${st.requestNamespace}:${String(msg.id)}`;
      st.pendingElicitations.set(requestId, { rpcId: msg.id, fields });
      sess.emit({
        kind: "elicitation-request",
        requestId,
        message: truncate(msg.params?.message ?? "Information requested", 300),
        fields,
      });
    } catch (error) {
      writeMsg({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32602, message: error instanceof Error ? error.message : String(error) },
      });
    }
    return;
  }
  if (msg.id != null && msg.method === "session/request_permission") {
    const options = permissionOptions(msg.params?.options);
    const allow = options.find((o) => o.kind === "allow_always")
      ?? options.find((o) => o.kind === "allow_once");
    // Never fall back to an arbitrary option when denying: if the agent only
    // offered allow options, picking options[0] would approve the tool even
    // though auto-approve is off. "cancelled" is the spec's no-selection
    // outcome.
    if (!st.autoApprove) {
      const requestId = `${st.requestNamespace}:${String(msg.id)}`;
      if (!options.length) {
        writeMsg({ jsonrpc: "2.0", id: msg.id, result: { outcome: { outcome: "cancelled" } } });
        sess.emit({ kind: "status", text: "permission request had no valid options" });
        return;
      }
      st.pendingPermissions.set(requestId, { rpcId: msg.id, options });
      const toolCallId = String(msg.params?.toolCall?.toolCallId ?? "");
      sess.emit({
        kind: "permission-request",
        requestId,
        title: truncate(msg.params?.toolCall?.title ?? st.toolTitles.get(toolCallId) ?? "Permission requested", 160),
        options,
      });
      return;
    }
    const choice = allow;
    writeMsg({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        outcome: choice
          ? { outcome: "selected", optionId: choice.optionId }
          : { outcome: "cancelled" },
      },
    });
    return;
  }
  if (msg.id != null) {
    writeMsg({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not supported by cmux-agent-ui" } });
  }
}

function normalizeCommands(commands: any): CommandEntry[] {
  if (!Array.isArray(commands)) return [];
  return commands.map((c) => ({
    name: String(c.name ?? "").replace(/^\/+/, ""),
    description: c.description ? String(c.description) : undefined,
    source: c.source ? String(c.source) : undefined,
  })).filter((c) => c.name);
}

function normalizePlanEntries(entries: unknown) {
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry) => {
    const content = typeof entry?.content === "string" ? entry.content.trim() : "";
    const status = typeof entry?.status === "string" ? entry.status : undefined;
    return content ? [{ content, status }] : [];
  });
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((c: any) => c?.content?.text ?? c?.text ?? "")
    .join("");
}

async function fetchAcpCommands(def: ProviderDef, cwd: string): Promise<CommandEntry[]> {
  if (!def.cmd?.length) return [];
  const proc = Bun.spawn(commandForSession(def, {}), {
    cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
  try {
    return await new Promise<CommandEntry[]>((resolve, reject) => {
      let nextId = 1;
      const pending = new Set<number>();
      const write = (method: string, params: unknown) => {
        const id = nextId++;
        pending.add(id);
        proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
        proc.stdin.flush();
        return id;
      };
      const timer = setTimeout(() => resolve([]), 8_000);
      readLines(proc.stdout, (line) => {
        const msg = tryParse(line);
        if (!msg) return;
        if (msg.id != null && pending.has(msg.id)) {
          pending.delete(msg.id);
          if (msg.error) {
            clearTimeout(timer);
            reject(new Error(msg.error.message ?? "acp command catalog failed"));
          } else if (msg.id === 1) {
            write("session/new", { cwd, mcpServers: [] });
          }
          return;
        }
        if (msg.method === "session/update" && msg.params?.update?.sessionUpdate === "available_commands_update") {
          clearTimeout(timer);
          resolve(normalizeCommands(msg.params.update.availableCommands));
        }
      }, () => {
        clearTimeout(timer);
        resolve([]);
      });
      write("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      });
    });
  } finally {
    proc.kill();
  }
}

async function fetchAcpOptions(def: ProviderDef, cwd: string, fallback: SessionOption[]): Promise<SessionOption[]> {
  if (!def.cmd?.length) return fallback;
  const proc = Bun.spawn(commandForSession(def, {}), {
    cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
  try {
    return await new Promise<SessionOption[]>((resolve, reject) => {
      let nextId = 1;
      const pending = new Set<number>();
      const write = (method: string, params: unknown) => {
        const id = nextId++;
        pending.add(id);
        proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
        proc.stdin.flush();
        return id;
      };
      const timer = setTimeout(() => resolve(fallback), 8_000);
      readLines(proc.stdout, (line) => {
        const msg = tryParse(line);
        if (!msg || msg.id == null || !pending.has(msg.id)) return;
        pending.delete(msg.id);
        if (msg.error) {
          clearTimeout(timer);
          reject(new Error(msg.error.message ?? "acp option catalog failed"));
        } else if (msg.id === 1) {
          write("session/new", { cwd, mcpServers: [] });
        } else {
          clearTimeout(timer);
          const st: AcpState = {
            proc,
            acpSessionId: "",
            request: () => Promise.reject(new Error("catalog probe closed")),
            notify: () => {},
            options: [],
            sources: new Map(),
            autoApprove: false,
            commands: [],
            initialApplied: false,
            pendingPermissions: new Map(),
            pendingElicitations: new Map(),
            toolTitles: new Map(),
            requestNamespace: "catalog",
            suppressSessionReplay: false,
            unsupportedUpdates: new Set(),
            writeMsg: () => {},
          };
          ingestAcpOptions(st, msg.result ?? {}, def, effectiveSpawnModel(def, {}));
          resolve(st.options.length ? st.options : fallback);
        }
      }, () => {
        clearTimeout(timer);
        resolve(fallback);
      });
      write("initialize", {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          elicitation: { form: {} },
        },
      });
    });
  } finally {
    proc.kill();
  }
}
