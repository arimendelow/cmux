// Common event schema every adapter normalizes into. The UI only knows this.
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
  | WorkbenchRestoreReceipt
  // Negotiated peer capabilities. `image` is three-state: `unknown` until the
  // ACP peer answers initialize, then `supported` / `unsupported`.
  | { kind: "capabilities"; image: ImagePromptCapability }
  | { kind: "user"; text: string }
  | { kind: "status"; text: string }
  | { kind: "delta"; text: string } // streaming assistant text
  | { kind: "assistant"; text: string } // full assistant message (non-streaming providers)
  | { kind: "thinking"; text: string } // streaming reasoning text
  | { kind: "tool-start"; toolId: string; name: string; detail?: string }
  | { kind: "tool-end"; toolId: string; name?: string; detail?: string; ok?: boolean }
  | { kind: "done"; stats?: string }
  | { kind: "files-changed"; files: ChangedFile[] }
  | { kind: "error"; message: string };

export type SessionStatus = "idle" | "running" | "exited" | "error";

export interface WorkbenchRestoreReceipt {
  kind: "workbench-restore";
  facts: Record<string, unknown> | null;
  unresolved: {
    window_id: string;
    workspace_id: string;
    pane_id: string;
    surface_id: string;
    reason: string;
  }[];
  assessment: "waiting" | "none" | "pending" | "running" | "cancelling" | "completed" | "cancelled" | "failed";
  error?: "native-unavailable" | "assessment-failed" | "cancel-failed";
}

export type ImagePromptCapability = "unknown" | "supported" | "unsupported";
export type OptionKind = "select" | "toggle";
export type OptionValue = string | boolean;
export type CommandTrigger = "/" | "$" | "@";

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always" | string;
}

export interface PlanEntry {
  content: string;
  status?: string;
}

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

export interface OptionChoice {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
  disabledReason?: string;
}

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

export interface CommandEntry {
  name: string;
  description?: string;
  source?: string;
}

export interface ProviderCapabilities {
  options: SessionOption[];
  triggers: CommandTrigger[];
  imageAttachments?: boolean;
}

export interface PromptAttachment {
  id: string;
  name: string;
  mimeType: string;
  data: string;
  byteCount: number;
}

export interface SessionActions {
  fork?: boolean;
}

export interface ChangedFile {
  path: string;
  adds: number;
  dels: number;
  status: string;
}

export interface SessionCtx {
  id: string;
  provider: string;
  cwd: string;
  title: string;
  autoApprove: boolean;
  startOptions: Record<string, OptionValue>;
  seedOptions?: SessionOption[];
  status: SessionStatus;
  events: AgentEvent[];
  // Adapter-private state (child proc, provider session/thread ids, rpc counters).
  internal: Record<string, unknown>;
  emit(evt: AgentEvent): void;
  setStatus(status: SessionStatus): void;
  invalidatePersistedSession?(): Promise<void>;
}

export interface Adapter {
  preparePromptAttachments?(
    sess: SessionCtx,
    attachments: PromptAttachment[],
  ): void | Promise<void>;
  sendWithAdmission?(
    sess: SessionCtx,
    prompt: string,
    generation: number | undefined,
    attachments: PromptAttachment[],
    onAdmitted: () => void,
    canAdmit?: () => boolean,
  ): Promise<void>;
  send(
    sess: SessionCtx,
    prompt: string,
    generation?: number,
    attachments?: PromptAttachment[],
  ): void | Promise<void>;
  stop(sess: SessionCtx): void | Promise<void>;
  dispose(sess: SessionCtx): void;
  setOption(sess: SessionCtx, id: string, value: OptionValue): Promise<void>;
  refreshOptions?(sess: SessionCtx): Promise<void>;
  listOptions?(cwd: string): Promise<SessionOption[]>;
  listCommands?(cwd: string): Promise<{ trigger: CommandTrigger; commands: CommandEntry[] }[]>;
  respondPermission?(sess: SessionCtx, requestId: string, optionId: string): Promise<void>;
  respondElicitation?(
    sess: SessionCtx,
    requestId: string,
    action: ElicitationAction,
    content?: Record<string, string | boolean | number>,
  ): Promise<void>;
  forkSession?(source: SessionCtx, target: SessionCtx): Promise<void>;
  /** Establish the peer connection without sending a user turn. */
  warmup?(sess: SessionCtx): Promise<void>;
  capabilities?: ProviderCapabilities;
}

export interface ProviderDef {
  id: string;
  label: string;
  description?: string;
  role?: "boss";
  adapter: string; // key into the adapter registry
  // Extra spawn config consumed by the adapter.
  cmd?: string[];
  autoApproveArgs?: string[];
  defaultAutoApprove?: boolean;
  probeCatalogs?: boolean;
  startupTimeoutMs?: number;
  unavailableReason?: string;
  installCommand?: string;
  models?: { value: string; label: string; description?: string }[];
  defaultModel?: string;
}
