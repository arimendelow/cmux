// Client-side session state: one WebSocket, one session per page.
import { useCallback, useEffect, useRef, useState } from "react";
import { applyThemeVars } from "./theme";

export type AgentEvent =
  | { kind: "meta"; model?: string; providerSessionId?: string }
  | { kind: "options"; options: SessionOption[]; actions?: SessionActions }
  | { kind: "commands"; trigger: CommandTrigger; commands: CommandEntry[] }
  | { kind: "plan"; entries: PlanEntry[] }
  | { kind: "elicitation-request"; requestId: string; message: string; fields: ElicitationField[] }
  | { kind: "elicitation-resolved"; requestId: string; action: ElicitationAction }
  | { kind: "permission-request"; requestId: string; title: string; options: PermissionOption[] }
  | { kind: "permission-resolved"; requestId: string; optionId: string }
  | { kind: "connection"; state: "starting" | "ready" | "failed"; title: string; message?: string }
  | { kind: "recovery"; mode: "resumed" | "respawned"; title: string; message: string }
  | { kind: "capabilities"; image: ImagePromptCapability }
  | { kind: "user"; text: string }
  | { kind: "status"; text: string }
  | { kind: "delta"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool-start"; toolId: string; name: string; detail?: string }
  | { kind: "tool-end"; toolId: string; name?: string; detail?: string; ok?: boolean }
  | { kind: "done"; stats?: string }
  | { kind: "files-changed"; files: ChangedFile[] }
  | { kind: "error"; message: string };

export type OptionKind = "select" | "toggle";
export type OptionValue = string | boolean;
export type CommandTrigger = "/" | "$" | "@";
export interface PermissionOption { optionId: string; name: string; kind: string; }
export interface PromptAttachment {
  id: string;
  name: string;
  mimeType: string;
  data: string;
  byteCount: number;
}
export interface PlanEntry { content: string; status?: string; }
export type ElicitationAction = "accept" | "decline" | "cancel";
export interface ElicitationField {
  name: string;
  type: "string" | "boolean" | "number" | "integer";
  title: string;
  description?: string;
  required: boolean;
  options?: string[];
  defaultValue?: string | boolean | number;
}
export interface OptionChoice { value: string; label: string; description?: string; disabled?: boolean; disabledReason?: string; }
export interface SessionOption {
  id: string;
  label: string;
  kind: OptionKind;
  value: OptionValue;
  role?: "effort" | "thinking-budget" | "approval" | "context";
  choices?: OptionChoice[];
  disabled?: boolean;
  description?: string;
}
export interface CommandEntry { name: string; description?: string; source?: string; }
export interface CommandGroup { trigger: CommandTrigger; commands: CommandEntry[]; }
export interface ProviderCapabilities {
  options: SessionOption[];
  triggers: CommandTrigger[];
  imageAttachments?: boolean;
}
export interface SessionActions { fork?: boolean; }
export interface ChangedFile { path: string; adds: number; dels: number; status: string; }

const diffKeySeparator = "\0";

export function fileDiffCacheKey(revision: string, path: string): string {
  return `${revision}${diffKeySeparator}${path}`;
}

export function decodeFileDiffRequest(value: string): { key: string; path: string } {
  const index = value.indexOf(diffKeySeparator);
  if (index < 0) return { key: value, path: value };
  return { key: value, path: value.slice(index + diffKeySeparator.length) };
}

function nextFilesRevision(blocks: Block[]): string {
  let count = 0;
  for (const block of blocks) {
    if (block.kind === "files") count += 1;
  }
  return String(count + 1);
}

export type Block =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; open: boolean }
  | { kind: "thinking"; text: string; open: boolean }
  | { kind: "tool"; toolId: string; name: string; detail?: string; status: "running" | "ok" | "fail"; out?: string }
  | { kind: "status"; text: string }
  | { kind: "error"; text: string }
  | { kind: "footer"; text: string }
  | { kind: "files"; files: ChangedFile[]; revision?: string }
  | { kind: "plan"; entries: PlanEntry[] }
  | { kind: "elicitation"; requestId: string; message: string; fields: ElicitationField[]; status: "pending" | "resolved"; action?: ElicitationAction }
  | { kind: "permission"; requestId: string; title: string; options: PermissionOption[]; status: "pending" | "resolved"; optionId?: string };

export interface Provider {
  id: string;
  label: string;
  description?: string;
  role?: "boss";
  iconUrl?: string;
  iconDarkUrl?: string;
  installed?: boolean;
  installCommand?: string;
  startupTimeoutMs?: number;
}
export type ExternalAuthorityStatus =
  | "connected"
  | "disconnected"
  | "stopped"
  | "unavailable"
  | "unknown";
export interface ExternalAuthority {
  label: string;
  openUrl?: string;
  openLabel?: string;
  status: ExternalAuthorityStatus;
}
export interface WorkbenchExperience {
  productName: string;
  surfaceName: string;
  contextLabel?: string;
  defaultProvider: string;
  localAuthorityLabel: string;
  externalAuthority: ExternalAuthority;
}
export type ImagePromptCapability = "unknown" | "supported" | "unsupported";
export type BossSkipReason =
  | "corrupt-record"
  | "cwd-unavailable"
  | "agent-mismatch"
  | "not-canonical";
export interface BossSkippedRecord { id: string; agent: string; reason: BossSkipReason; }
export interface BossState {
  status: "none" | "canonical" | "blocked";
  agent: string;
  sessionId?: string;
  reason?: string;
  detail?: string;
  skipped: BossSkippedRecord[];
}
export interface WorkbenchActionAvailability { fork: boolean; compose: boolean; delete: boolean; }
/** Host-published app continuity, consumed read-only by the Boss surface. */
export interface AppContinuity {
  appInstanceId: string;
  startedAt: string;
  previousExitClean: boolean;
}
export interface RecoveryState { mode: "resumed" | "respawned"; title: string; message: string; }
export interface ConnectionState { state: "starting"; title: string; message?: string; }
export interface SessionSummary { id: string; provider: string; cwd: string; title: string; status: string; createdAt?: number; capabilities?: ProviderCapabilities; }
export type CtrlJMode = "newline" | "menu";

function closeStreaming(blocks: Block[]): Block[] {
  const last = blocks[blocks.length - 1];
  if (last && (last.kind === "assistant" || last.kind === "thinking") && last.open) {
    return [...blocks.slice(0, -1), { ...last, open: false }];
  }
  return blocks;
}

export function foldEvent(blocks: Block[], evt: AgentEvent): Block[] {
  const last = blocks[blocks.length - 1];
  switch (evt.kind) {
    case "user":
      return [...closeStreaming(blocks), { kind: "user", text: evt.text }];
    case "delta":
      if (last && last.kind === "assistant" && last.open) {
        return [...blocks.slice(0, -1), { ...last, text: last.text + evt.text }];
      }
      return [...closeStreaming(blocks), { kind: "assistant", text: evt.text, open: true }];
    case "assistant":
      if (last && last.kind === "assistant" && last.open) {
        return [...blocks.slice(0, -1), { ...last, text: evt.text, open: false }];
      }
      return [...closeStreaming(blocks), { kind: "assistant", text: evt.text, open: false }];
    case "thinking":
      if (last && last.kind === "thinking" && last.open) {
        return [...blocks.slice(0, -1), { ...last, text: last.text + evt.text }];
      }
      return [...closeStreaming(blocks), { kind: "thinking", text: evt.text, open: true }];
    case "tool-start":
      return [...closeStreaming(blocks), { kind: "tool", toolId: evt.toolId, name: evt.name || "tool", detail: evt.detail, status: "running" }];
    case "tool-end":
      return blocks.map((b) =>
        b.kind === "tool" && b.toolId === evt.toolId
          ? { ...b, status: evt.ok === false ? "fail" : "ok", out: evt.detail || b.out }
          : b,
      );
    case "done": {
      const closed = closeStreaming(blocks);
      return [...closed, { kind: "footer", text: evt.stats ?? "" }];
    }
    case "files-changed":
      return [...closeStreaming(blocks), { kind: "files", files: evt.files, revision: nextFilesRevision(blocks) }];
    case "error":
      return [...closeStreaming(blocks), { kind: "error", text: evt.message }];
    case "status":
      return [...closeStreaming(blocks), { kind: "status", text: evt.text }];
    case "plan":
      return [...closeStreaming(blocks), { kind: "plan", entries: evt.entries }];
    case "elicitation-request":
      return [...closeStreaming(blocks), {
        kind: "elicitation",
        requestId: evt.requestId,
        message: evt.message,
        fields: evt.fields,
        status: "pending",
      }];
    case "elicitation-resolved":
      return blocks.map((block) =>
        block.kind === "elicitation" && block.requestId === evt.requestId
          ? { ...block, status: "resolved", action: evt.action }
          : block
      );
    case "permission-request":
      return [...closeStreaming(blocks), {
        kind: "permission",
        requestId: evt.requestId,
        title: evt.title,
        options: evt.options,
        status: "pending",
      }];
    case "permission-resolved":
      return blocks.map((block) =>
        block.kind === "permission" && block.requestId === evt.requestId
          ? { ...block, status: "resolved", optionId: evt.optionId }
          : block
      );
    case "recovery":
    case "connection":
    case "capabilities":
      return blocks;
    default:
      return blocks;
  }
}

interface Hello {
  providers: Provider[];
  defaultCwd: string;
  defaultProvider?: string;
  experience?: WorkbenchExperience;
  boss?: BossState;
  continuity?: AppContinuity | null;
  keys?: { ctrlJ?: CtrlJMode };
}

export interface SessionState {
  ready: boolean;
  connectionEpoch: number;
  providers: Provider[];
  capabilities: Record<string, ProviderCapabilities>;
  defaultCwd: string;
  defaultProvider: string;
  experience: WorkbenchExperience | null;
  boss: BossState | null;
  continuity: AppContinuity | null;
  imageCapability: ImagePromptCapability;
  actionsAllowed: WorkbenchActionAvailability;
  connection: ConnectionState | null;
  recovery: RecoveryState | null;
  ctrlJ: CtrlJMode;
  phase: "composer" | "chat";
  session: SessionSummary | null;
  blocks: Block[];
  options: SessionOption[];
  actions: SessionActions;
  commands: CommandGroup[];
  providerOptions: Record<string, SessionOption[]>;
  providerCommands: Record<string, CommandGroup[]>;
  filesByCwd: Record<string, string[]>;
  cwdChecks: Record<string, { ok: boolean; message?: string }>;
  fileDiffs: Record<string, string>;
  lastError: string;
  composerAttachments: PromptAttachment[];
  forkPending: boolean;
  start(opts: { provider: string; cwd: string; prompt: string; attachments?: PromptAttachment[]; options?: Record<string, OptionValue> }): boolean;
  compose(options?: { attachments?: PromptAttachment[]; error?: string }): void;
  reply(text: string, attachments?: PromptAttachment[]): Promise<boolean>;
  stop(): void;
  setOption(id: string, value: OptionValue): void;
  respondPermission(requestId: string, optionId: string): void;
  respondElicitation(
    requestId: string,
    action: ElicitationAction,
    content?: Record<string, string | boolean | number>,
  ): void;
  fork(): void;
  requestProviderOptions(provider: string, cwd: string): void;
  requestProviderCommands(provider: string, cwd: string): void;
  requestFiles(cwd: string, query?: string): void;
  requestFileDiff(sessionId: string, path: string): void;
  checkCwd(cwd: string): void;
  clearError(): void;
}

declare global {
  interface Window { __AGENT_CHAT_BASE__?: string }
}

function basePrefix(): string {
  const base = typeof window === "undefined" ? "" : window.__AGENT_CHAT_BASE__ ?? "";
  return base && base !== "/" ? base.replace(/\/$/, "") : "";
}

function routePath(): string {
  if (typeof location === "undefined") return "/";
  const base = basePrefix();
  if (!base) return location.pathname;
  // Bare /<token> (no trailing slash) is the app root.
  if (location.pathname === base) return "/";
  return location.pathname.startsWith(base + "/") ? location.pathname.slice(base.length) : location.pathname;
}

function appPath(path: string): string {
  return `${basePrefix()}${path}`;
}

const routedSessionId = (routePath().match(/^\/s\/([\w-]+)/) || [])[1] || null;
export const composerDraftKey = "agentui.draft";
const PENDING_START_TIMEOUT_MS = 30_000;

export function restoreComposerDraft(storage: Pick<Storage, "setItem">, prompt: string) {
  storage.setItem(composerDraftKey, prompt);
}

export function consumeOptimisticUserEcho(queue: string[], text: string): boolean {
  if (queue[0] !== text) return false;
  queue.shift();
  return true;
}

export function settlePendingReply(
  pending: Map<string, (accepted: boolean) => void>,
  requestId: string,
  accepted: boolean,
): boolean {
  const resolve = pending.get(requestId);
  if (!resolve) return false;
  pending.delete(requestId);
  resolve(accepted);
  return true;
}

export function rememberRetiredId(ids: Set<string>, id: string, limit = 32): void {
  ids.delete(id);
  ids.add(id);
  while (ids.size > limit) {
    const oldest = ids.values().next().value;
    if (typeof oldest !== "string") break;
    ids.delete(oldest);
  }
}

export function promptDisplayText(
  prompt: string,
  attachments: ReadonlyArray<Pick<PromptAttachment, "name">>,
): string {
  return [
    prompt,
    ...attachments.map((attachment) => `[Image: ${attachment.name}]`),
  ].filter(Boolean).join("\n");
}

export function providerSessionTitle(
  providers: Provider[],
  provider: string,
  experience: WorkbenchExperience | null = null,
): string {
  const definition = providers.find((candidate) => candidate.id === provider);
  if (definition?.role === "boss" && experience) return experience.surfaceName;
  return definition?.label ?? "Agent";
}

export function providerStartTimeoutMs(providers: Provider[], provider: string): number {
  return providers.find((candidate) => candidate.id === provider)?.startupTimeoutMs ?? PENDING_START_TIMEOUT_MS;
}

export function resolveProviderSelection(providers: Provider[], current: string, preferred = ""): string {
  const installed = providers.filter((provider) => provider.installed !== false);
  if (installed.some((provider) => provider.id === current)) return current;
  if (installed.some((provider) => provider.id === preferred)) return preferred;
  return installed[0]?.id ?? current;
}

/**
 * The canonical Boss always comes from the server. Recency heuristics are gone
 * on purpose: a newer session must never win over the server's pointer.
 */
export function applyCanonicalBoss(
  sessions: SessionSummary[],
  boss: BossState | null,
  experience: WorkbenchExperience | null,
): SessionSummary | null {
  if (!experience || !boss || boss.status !== "canonical" || !boss.sessionId) return null;
  return sessions.find((session) => session.id === boss.sessionId) ?? null;
}

/**
 * Boss preserves a restart visibly without restating the world model: one short
 * notice when the host reported an unclean previous exit, and nothing at all
 * otherwise. Restore progress, topology, and launch identity stay with their
 * owner.
 */
export function appContinuityNotice(continuity: AppContinuity | null): string {
  if (!continuity || continuity.previousExitClean) return "";
  return "Restarted after an unclean shutdown";
}

export function bossBlockedMessage(boss: BossState | null): string {
  if (!boss || boss.status !== "blocked") return "";
  return `Boss recovery is blocked (${boss.reason}): ${boss.detail}`;
}

/** Workbench has one continuous Boss relationship: no new, reset, delete, fork. */
export function workbenchActionsAllowed(
  experience: WorkbenchExperience | null,
): WorkbenchActionAvailability {
  const allowed = !experience;
  return { fork: allowed, compose: allowed, delete: allowed };
}

/**
 * Image attachment is offered only once the peer has positively advertised it.
 * Text submission is never blocked on negotiation: a peer that dies resets the
 * capability to `unknown`, and blocking send there would leave a Workbench with
 * no new/reset action unable to revive its own Boss.
 */
export function imageAttachmentAllowed(capability: ImagePromptCapability): boolean {
  return capability === "supported";
}

/** The composer keeps its draft in every capability state. */
export function draftSurvivesCapabilityChange(): boolean {
  return true;
}

/** Rebuild the negotiated capability from replayed history after a reconnect. */
export function latestImageCapability(events: AgentEvent[]): ImagePromptCapability {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.kind === "capabilities") return event.image;
  }
  return "unknown";
}

export function useSession(): SessionState {
  const [ready, setReady] = useState(false);
  const [connectionEpoch, setConnectionEpoch] = useState(0);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [capabilities, setCapabilities] = useState<Record<string, ProviderCapabilities>>({});
  const [defaultCwd, setDefaultCwd] = useState("");
  const [defaultProvider, setDefaultProvider] = useState("");
  const [experience, setExperience] = useState<WorkbenchExperience | null>(null);
  const [boss, setBoss] = useState<BossState | null>(null);
  const [continuity, setContinuity] = useState<AppContinuity | null>(null);
  const [imageCapability, setImageCapability] = useState<ImagePromptCapability>("unknown");
  const [connection, setConnection] = useState<ConnectionState | null>(null);
  const [recovery, setRecovery] = useState<RecoveryState | null>(null);
  const [ctrlJ, setCtrlJ] = useState<CtrlJMode>("newline");
  const [phase, setPhase] = useState<"composer" | "chat">(routedSessionId ? "chat" : "composer");
  const [session, setSession] = useState<SessionSummary | null>(null);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [options, setOptions] = useState<SessionOption[]>([]);
  const [actions, setActions] = useState<SessionActions>({});
  const [commands, setCommands] = useState<CommandGroup[]>([]);
  const [providerOptions, setProviderOptions] = useState<Record<string, SessionOption[]>>({});
  const [providerCommands, setProviderCommands] = useState<Record<string, CommandGroup[]>>({});
  const [filesByCwd, setFilesByCwd] = useState<Record<string, string[]>>({});
  const [cwdChecks, setCwdChecks] = useState<Record<string, { ok: boolean; message?: string }>>({});
  const [fileDiffs, setFileDiffs] = useState<Record<string, string>>({});
  const [lastError, setLastError] = useState("");
  const [composerAttachments, setComposerAttachments] = useState<PromptAttachment[]>([]);
  const [forkPending, setForkPending] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const providersRef = useRef<Provider[]>([]);
  const sessionIdRef = useRef<string | null>(routedSessionId);
  const pendingFileDiffKeysRef = useRef<Record<string, string[]>>({});
  const pendingStartRef = useRef<{
    requestId: string;
    key: string;
    provider: string;
    cwd: string;
    prompt: string;
    attachments?: PromptAttachment[];
    options?: Record<string, OptionValue>;
    queuedReplies: Array<{ requestId: string; prompt: string; attachments?: PromptAttachment[] }>;
    failed?: boolean;
  } | null>(null);
  const pendingStartTimeoutRef = useRef<number | null>(null);
  const pendingRepliesRef = useRef(new Map<string, (accepted: boolean) => void>());
  const retiredStartRequestIdsRef = useRef(new Set<string>());
  const retiredSessionIdsRef = useRef(new Set<string>());
  const optimisticUsersRef = useRef<string[]>([]);
  const experienceRef = useRef<WorkbenchExperience | null>(null);
  const bossRef = useRef<BossState | null>(null);
  const initialSessionListHandledRef = useRef(false);

  const clearPendingStartTimeout = useCallback(() => {
    if (pendingStartTimeoutRef.current) window.clearTimeout(pendingStartTimeoutRef.current);
    pendingStartTimeoutRef.current = null;
  }, []);

  const failPendingStart = useCallback((message: string) => {
    const pending = pendingStartRef.current;
    if (!pending) return;
    rememberRetiredId(retiredStartRequestIdsRef.current, pending.requestId);
    for (const queued of pending.queuedReplies) {
      pendingRepliesRef.current.get(queued.requestId)?.(false);
      pendingRepliesRef.current.delete(queued.requestId);
    }
    clearPendingStartTimeout();
    pendingStartRef.current = null;
    restoreComposerDraft(sessionStorage, pending.prompt);
    setComposerAttachments(pending.attachments ?? []);
    history.replaceState(null, "", appPath("/"));
    document.title = "cmux agent";
    sessionIdRef.current = null;
    optimisticUsersRef.current = [];
    setSession(null);
    setBlocks([]);
    setOptions([]);
    setActions({});
    setCommands([]);
    pendingFileDiffKeysRef.current = {};
    setFileDiffs({});
    setLastError(message);
    setPhase("composer");
  }, [clearPendingStartTimeout]);

  const armPendingStartTimeout = useCallback((provider: string) => {
    clearPendingStartTimeout();
    pendingStartTimeoutRef.current = window.setTimeout(() => {
      const pending = pendingStartRef.current;
      if (pending) {
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ op: "cancel-start", requestId: pending.requestId, retire: true }));
        }
      }
      failPendingStart("Failed to start agent: request timed out");
    }, providerStartTimeoutMs(providersRef.current, provider));
  }, [clearPendingStartTimeout, failPendingStart]);

  const sendRaw = useCallback((obj: unknown) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }, []);

  useEffect(() => {
    let closed = false;
    const connect = () => {
      const ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + appPath("/ws"));
      wsRef.current = ws;
      ws.onopen = () => {
        for (const requestId of retiredStartRequestIdsRef.current) {
          sendRaw({ op: "cancel-start", requestId, retire: true });
        }
        const pending = pendingStartRef.current;
        if (sessionIdRef.current) {
          sendRaw({ op: "subscribe", sessionId: sessionIdRef.current });
          sendRaw({ op: "warm-boss" });
        }
        else if (pending && !pending.failed) {
          sendRaw({ op: "start", requestId: pending.requestId, provider: pending.provider, cwd: pending.cwd, prompt: pending.prompt, attachments: pending.attachments, options: pending.options });
          armPendingStartTimeout(pending.provider);
        }
      };
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        switch (msg.kind) {
          case "hello": {
            const h = msg as Hello & { kind: string; capabilities?: Record<string, ProviderCapabilities> };
            providersRef.current = h.providers;
            setProviders(h.providers);
            setCapabilities(h.capabilities ?? {});
            setDefaultCwd(h.defaultCwd);
            setDefaultProvider(h.defaultProvider ?? "");
            experienceRef.current = h.experience ?? null;
            setExperience(experienceRef.current);
            bossRef.current = h.boss ?? null;
            setBoss(bossRef.current);
            setContinuity(h.continuity ?? null);
            if (h.boss?.status === "blocked") setLastError(bossBlockedMessage(h.boss));
            setCtrlJ(h.keys?.ctrlJ === "menu" ? "menu" : "newline");
            setReady(true);
            setConnectionEpoch((n) => n + 1);
            break;
          }
          case "session-created":
            if (
              typeof msg.requestId === "string"
              && retiredStartRequestIdsRef.current.has(msg.requestId)
            ) {
              rememberRetiredId(retiredSessionIdsRef.current, String(msg.session.id));
              sendRaw({ op: "cancel-start", requestId: msg.requestId, retire: true });
              if (sessionIdRef.current) {
                sendRaw({ op: "subscribe", sessionId: sessionIdRef.current });
              }
              break;
            }
            sessionIdRef.current = msg.session.id;
            history.replaceState(null, "", appPath("/s/" + msg.session.id));
            document.title = msg.session.title || "cmux agent";
            if (msg.requestId && pendingStartRef.current?.requestId === msg.requestId) {
              const queuedReplies = pendingStartRef.current.queuedReplies;
              clearPendingStartTimeout();
              pendingStartRef.current = null;
              setSession({ ...msg.session, status: "running" });
              for (const queued of queuedReplies) {
                if (!sendRaw({ op: "send", sessionId: msg.session.id, ...queued })) {
                  pendingRepliesRef.current.get(queued.requestId)?.(false);
                  pendingRepliesRef.current.delete(queued.requestId);
                }
              }
            } else {
              setSession(msg.session);
              setBlocks([]);
              setConnection(null);
              optimisticUsersRef.current = [];
            }
            setOptions([]);
            setActions({});
            setCommands([]);
            setRecovery(null);
            pendingFileDiffKeysRef.current = {};
            setFileDiffs({});
            setPhase("chat");
            break;
          case "start-retired":
            if (typeof msg.requestId === "string") {
              retiredStartRequestIdsRef.current.delete(msg.requestId);
            }
            break;
          case "send-accepted": {
            const requestId = typeof msg.requestId === "string" ? msg.requestId : "";
            settlePendingReply(pendingRepliesRef.current, requestId, true);
            break;
          }
          case "history":
            if (retiredSessionIdsRef.current.has(String(msg.session.id))) break;
            sessionIdRef.current = msg.session.id;
            document.title = msg.session.title || "cmux agent";
            setSession(msg.session);
            setBlocks((msg.events as AgentEvent[]).reduce(foldEvent, [] as Block[]));
            setConnection(latestConnection(msg.events as AgentEvent[]));
            setRecovery(latestRecovery(msg.events as AgentEvent[]));
            setImageCapability(latestImageCapability(msg.events as AgentEvent[]));
            optimisticUsersRef.current = [];
            setOptions(latestOptions(msg.events as AgentEvent[]));
            setActions(latestActions(msg.events as AgentEvent[]));
            setCommands(latestCommands(msg.events as AgentEvent[]));
            pendingFileDiffKeysRef.current = {};
            setFileDiffs({});
            setPhase("chat");
            break;
          case "no-session":
            history.replaceState(null, "", appPath("/"));
            sessionIdRef.current = null;
            setSession(null);
            setOptions([]);
            setActions({});
            setCommands([]);
            setConnection(null);
            setRecovery(null);
            pendingFileDiffKeysRef.current = {};
            setFileDiffs({});
            setPhase("composer");
            optimisticUsersRef.current = [];
            break;
          case "boss-state":
            bossRef.current = (msg.boss as BossState) ?? null;
            setBoss(bossRef.current);
            if (bossRef.current?.status === "blocked") setLastError(bossBlockedMessage(bossRef.current));
            break;
          case "sessions": {
            if (initialSessionListHandledRef.current) break;
            initialSessionListHandledRef.current = true;
            if (routedSessionId || sessionIdRef.current || pendingStartRef.current) break;
            const recovered = applyCanonicalBoss(msg.sessions ?? [], bossRef.current, experienceRef.current);
            if (!recovered) break;
            sessionIdRef.current = recovered.id;
            history.replaceState(null, "", appPath("/s/" + recovered.id));
            setSession(recovered);
            setBlocks([]);
            setConnection(null);
            setRecovery(null);
            setPhase("chat");
            sendRaw({ op: "subscribe", sessionId: recovered.id });
            break;
          }
          case "session-status":
            if (msg.sessionId === sessionIdRef.current) {
              setSession((s) => (s ? { ...s, status: msg.status } : s));
            }
            break;
          case "event":
            if (msg.sessionId === sessionIdRef.current) {
              const evt = msg.evt as AgentEvent;
              if (evt.kind === "connection") {
                setConnection(evt.state === "starting"
                  ? { state: "starting", title: evt.title, message: evt.message }
                  : null);
                break;
              }
              if (evt.kind === "recovery") {
                setRecovery({ mode: evt.mode, title: evt.title, message: evt.message });
                break;
              }
              if (evt.kind === "capabilities") {
                setImageCapability(evt.image);
                break;
              }
              if (evt.kind === "user" && consumeOptimisticUserEcho(optimisticUsersRef.current, evt.text)) {
                break;
              }
              setBlocks((bs) => foldEvent(bs, evt));
              if (evt.kind === "options") setOptions(evt.options);
              if (evt.kind === "options") setActions(evt.actions ?? {});
              if (evt.kind === "commands") setCommands((gs) => upsertCommands(gs, evt));
              if (evt.kind === "error") setForkPending(false);
            }
            break;
          case "session-forked":
            setForkPending(false);
            window.open(appPath("/s/" + msg.session.id), "_blank");
            break;
          case "options-list":
            setProviderOptions((m) => ({ ...m, [msg.provider]: msg.options ?? [] }));
            break;
          case "model-catalog":
            if (msg.options && typeof msg.options === "object") {
              setProviderOptions((current) => ({ ...current, ...msg.options }));
            }
            break;
          case "commands-list":
            setProviderCommands((m) => ({ ...m, [msg.provider]: msg.groups ?? [] }));
            break;
          case "files-list":
            setFilesByCwd((m) => ({ ...m, [msg.cwd]: msg.files ?? [] }));
            break;
          case "cwd-check":
            setCwdChecks((m) => ({ ...m, [msg.cwd]: { ok: Boolean(msg.ok), message: msg.message } }));
            break;
          case "theme":
            if (msg.vars && typeof msg.vars === "object") applyThemeVars(msg.vars, msg.theme);
            break;
          case "file-diff":
            if (msg.sessionId === sessionIdRef.current) {
              const path = String(msg.path);
              const queue = pendingFileDiffKeysRef.current[path];
              const key = queue?.shift() ?? path;
              if (queue && !queue.length) delete pendingFileDiffKeysRef.current[path];
              setFileDiffs((m) => ({ ...m, [key]: String(msg.diff ?? "") }));
            }
            break;
          case "error":
            if (msg.op === "start") {
              if (
                typeof msg.requestId === "string"
                && retiredStartRequestIdsRef.current.has(msg.requestId)
              ) {
                break;
              }
              const message = String(msg.message ?? "");
              const pending = pendingStartRef.current;
              if (pending && (!msg.requestId || msg.requestId === pending.requestId)) {
                failPendingStart(message);
              } else {
                setLastError(message);
              }
            }
            if (msg.op === "send") {
              const requestId = typeof msg.requestId === "string" ? msg.requestId : "";
              settlePendingReply(pendingRepliesRef.current, requestId, false);
              setLastError(String(msg.message ?? "Failed to send message"));
            }
            if (msg.op === "fork") setForkPending(false);
            if (msg.op === "get-file-diff" && typeof msg.path === "string" && msg.path) {
              const path = String(msg.path);
              const queue = pendingFileDiffKeysRef.current[path];
              const key = queue?.shift() ?? path;
              if (queue && !queue.length) delete pendingFileDiffKeysRef.current[path];
              setFileDiffs((m) => ({ ...m, [key]: String(msg.message ?? "Failed to load diff") }));
            }
            break;
        }
      };
      ws.onclose = () => {
        for (const resolve of pendingRepliesRef.current.values()) resolve(false);
        pendingRepliesRef.current.clear();
        if (!closed) setTimeout(connect, 800);
      };
    };
    connect();
    return () => {
      closed = true;
      clearPendingStartTimeout();
      for (const resolve of pendingRepliesRef.current.values()) resolve(false);
      pendingRepliesRef.current.clear();
      wsRef.current?.close();
    };
  }, [armPendingStartTimeout, clearPendingStartTimeout, failPendingStart, sendRaw]);

  const start = useCallback((opts: { provider: string; cwd: string; prompt: string; attachments?: PromptAttachment[]; options?: Record<string, OptionValue> }) => {
    const key = JSON.stringify([
      opts.provider,
      opts.cwd,
      opts.prompt,
      opts.attachments?.map((attachment) => attachment.id) ?? [],
      opts.options ?? {},
    ]);
    const current = pendingStartRef.current;
    if (current && !current.failed && current.key === key) return false;
    const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    if (!sendRaw({ op: "start", requestId, ...opts })) return false;
    pendingStartRef.current = { requestId, key, queuedReplies: [], ...opts };
    setComposerAttachments([]);
    armPendingStartTimeout(opts.provider);
    const displayPrompt = promptDisplayText(opts.prompt, opts.attachments ?? []);
    optimisticUsersRef.current = [displayPrompt];
    sessionIdRef.current = null;
    history.replaceState(null, "", appPath("/"));
    const title = providerSessionTitle(providers, opts.provider, experience);
    document.title = title;
    setLastError("");
    setSession({
      id: `pending-${requestId}`,
      provider: opts.provider,
      cwd: opts.cwd,
      title,
      status: "running",
    });
    setBlocks([{ kind: "user", text: displayPrompt }]);
    setOptions([]);
    setActions({});
    setCommands([]);
    setConnection({
      state: "starting",
      title: `Starting ${title}`,
      message: "Connecting to the local ACP session.",
    });
    setRecovery(null);
    pendingFileDiffKeysRef.current = {};
    setFileDiffs({});
    setPhase("chat");
    return true;
  }, [armPendingStartTimeout, experience, providers, sendRaw]);
  const compose = useCallback((options: { attachments?: PromptAttachment[]; error?: string } = {}) => {
    if (experienceRef.current) return;
    clearPendingStartTimeout();
    pendingStartRef.current = null;
    setComposerAttachments(options.attachments ?? []);
    history.replaceState(null, "", appPath("/"));
    document.title = "cmux agent";
    sessionIdRef.current = null;
    setSession(null);
    setBlocks([]);
    setOptions([]);
    setActions({});
    setCommands([]);
    setConnection(null);
    setRecovery(null);
    pendingFileDiffKeysRef.current = {};
    setFileDiffs({});
    setLastError(options.error ?? "");
    setPhase("composer");
  }, [clearPendingStartTimeout]);
  const reply = useCallback((text: string, attachments: PromptAttachment[] = []): Promise<boolean> => {
    const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const pending = pendingStartRef.current;
    if (!sessionIdRef.current && pending?.failed) {
      return Promise.resolve(start({
        provider: pending.provider,
        cwd: pending.cwd,
        prompt: text,
        attachments,
        options: pending.options,
      }));
    }
    return new Promise<boolean>((resolve) => {
      pendingRepliesRef.current.set(requestId, resolve);
      if (!sessionIdRef.current && pending && !pending.failed) {
        pending.queuedReplies.push({ requestId, prompt: text, attachments });
        return;
      }
      if (sessionIdRef.current && sendRaw({
        op: "send",
        requestId,
        sessionId: sessionIdRef.current,
        prompt: text,
        attachments,
      })) {
        setSession((s) => (s ? { ...s, status: "running" } : s));
        return;
      }
      pendingRepliesRef.current.delete(requestId);
      resolve(false);
    });
  }, [sendRaw, start]);
  const stop = useCallback(() => {
    if (sessionIdRef.current) {
      sendRaw({ op: "stop", sessionId: sessionIdRef.current });
      return;
    }
    const pending = pendingStartRef.current;
    if (pending && !pending.failed) sendRaw({ op: "cancel-start", requestId: pending.requestId });
  }, [sendRaw]);
  const setOption = useCallback((id: string, value: OptionValue) => {
    if (sessionIdRef.current) sendRaw({ op: "set-option", sessionId: sessionIdRef.current, id, value });
  }, [sendRaw]);
  const respondPermission = useCallback((requestId: string, optionId: string) => {
    if (sessionIdRef.current) {
      sendRaw({ op: "permission-response", sessionId: sessionIdRef.current, requestId, optionId });
    }
  }, [sendRaw]);
  const respondElicitation = useCallback((
    requestId: string,
    action: ElicitationAction,
    content?: Record<string, string | boolean | number>,
  ) => {
    if (sessionIdRef.current) {
      sendRaw({ op: "elicitation-response", sessionId: sessionIdRef.current, requestId, action, content });
    }
  }, [sendRaw]);
  const fork = useCallback(() => {
    if (experienceRef.current) return;
    if (sessionIdRef.current) {
      if (sendRaw({ op: "fork", sessionId: sessionIdRef.current })) setForkPending(true);
    }
  }, [sendRaw]);
  const requestProviderOptions = useCallback((provider: string, cwd: string) => {
    sendRaw({ op: "list-options", provider, cwd });
  }, [sendRaw]);
  const requestProviderCommands = useCallback((provider: string, cwd: string) => {
    sendRaw({ op: "list-commands", provider, cwd });
  }, [sendRaw]);
  const requestFiles = useCallback((cwd: string, query?: string) => {
    sendRaw({ op: "list-files", cwd, query });
  }, [sendRaw]);
  const requestFileDiff = useCallback((sessionId: string, path: string) => {
    const request = decodeFileDiffRequest(path);
    if (sendRaw({ op: "get-file-diff", sessionId, path: request.path })) {
      pendingFileDiffKeysRef.current[request.path] = [...(pendingFileDiffKeysRef.current[request.path] ?? []), request.key];
    }
  }, [sendRaw]);
  const checkCwd = useCallback((cwd: string) => {
    sendRaw({ op: "check-cwd", cwd });
  }, [sendRaw]);
  const clearError = useCallback(() => setLastError(""), []);

  return {
    ready,
    connectionEpoch,
    providers,
    capabilities,
    defaultCwd,
    defaultProvider,
    experience,
    boss,
    continuity,
    imageCapability,
    actionsAllowed: workbenchActionsAllowed(experience),
    connection,
    recovery,
    ctrlJ,
    phase,
    session,
    blocks,
    options,
    actions,
    commands,
    providerOptions,
    providerCommands,
    filesByCwd,
    cwdChecks,
    fileDiffs,
    lastError,
    composerAttachments,
    forkPending,
    start,
    compose,
    reply,
    stop,
    setOption,
    respondPermission,
    respondElicitation,
    fork,
    requestProviderOptions,
    requestProviderCommands,
    requestFiles,
    requestFileDiff,
    checkCwd,
    clearError,
  };
}

function latestOptions(events: AgentEvent[]): SessionOption[] {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].kind === "options") return (events[i] as Extract<AgentEvent, { kind: "options" }>).options;
  }
  return [];
}

function latestActions(events: AgentEvent[]): SessionActions {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].kind === "options") return (events[i] as Extract<AgentEvent, { kind: "options" }>).actions ?? {};
  }
  return {};
}

function latestCommands(events: AgentEvent[]): CommandGroup[] {
  return events.reduce((groups, evt) => evt.kind === "commands" ? upsertCommands(groups, evt) : groups, [] as CommandGroup[]);
}

function latestRecovery(events: AgentEvent[]): RecoveryState | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.kind === "recovery") {
      return { mode: event.mode, title: event.title, message: event.message };
    }
  }
  return null;
}

function latestConnection(events: AgentEvent[]): ConnectionState | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.kind === "connection") {
      return event.state === "starting"
        ? { state: "starting", title: event.title, message: event.message }
        : null;
    }
  }
  return null;
}

function upsertCommands(groups: CommandGroup[], evt: Extract<AgentEvent, { kind: "commands" }>): CommandGroup[] {
  const next = groups.filter((g) => g.trigger !== evt.trigger);
  if (evt.commands.length) next.push({ trigger: evt.trigger, commands: evt.commands });
  return next;
}
