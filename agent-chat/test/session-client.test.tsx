import { afterAll, beforeAll, expect, test } from "bun:test";
import { act, createElement } from "react";
import { getEventListeners } from "node:events";
import {
  applyCanonicalBoss, fileDiffCacheKey, foldEvent, latestImageCapability,
  rememberRetiredId, resolveProviderSelection, useSession,
  type AgentEvent, type Block, type SessionState,
} from "../src/session";
import { clientFixture } from "./client-fixture";

const originalSocket = globalThis.WebSocket;
const originalFetch = globalThis.fetch;
class ServerSocket {
  static OPEN = 1;
  static all: ServerSocket[] = [];
  static connected: (() => void) | undefined;
  readyState = 0;
  sent: any[] = [];
  onopen?: (event: Event) => void;
  onclose?: (event: Event) => void;
  onmessage?: (event: { data: string }) => void;
  constructor(readonly address: string) {
    const url = new URL(address);
    if (!["ws:", "wss:"].includes(url.protocol) || url.hostname !== "example.invalid" || !url.pathname.endsWith("/ws")) {
      throw new Error(`Unexpected client endpoint: ${address}`);
    }
    ServerSocket.all.push(this);
    ServerSocket.connected?.();
  }
  send(data: string) { expect(this.readyState).toBe(1); this.sent.push(JSON.parse(data)); }
  open() { this.readyState = 1; this.onopen?.(new Event("open")); }
  receive(message: unknown) { this.onmessage?.({ data: JSON.stringify(message) }); }
  close() { this.readyState = 3; this.onclose?.(new Event("close")); }
}
beforeAll(() => {
  globalThis.WebSocket = ServerSocket as any;
  globalThis.fetch = (() => { throw new Error("Session hook must use its explicitly faked WebSocket, not fetch"); }) as any;
});
afterAll(() => {
  globalThis.WebSocket = originalSocket;
  globalThis.fetch = originalFetch;
});

const experience = {
  productName: "Workbench", surfaceName: "Boss", defaultProvider: "demo", localAuthorityLabel: "Controlled here",
  externalAuthority: { label: "External", status: "unknown" as const },
};
const session = (id = "session-1") => ({ id, provider: "demo", title: "Demo", cwd: "/work", status: "idle" });
const attachment = { id: "image-1", name: "photo.png", mimeType: "image/png", data: "cG5n", byteCount: 3 };
const startOptions = { provider: "demo", cwd: "/work", prompt: "Read this image", attachments: [attachment], options: { model: "first" } };
const hello = (extra: Record<string, unknown> = {}) => ({
  kind: "hello", providers: [{ id: "demo", label: "Demo", installed: true, role: "boss" }],
  defaultCwd: "/work", ...extra,
});

async function client(url = "http://example.invalid", locale = "en") {
  ServerSocket.all = [];
  const fixture = await clientFixture(url, undefined, locale);
  let state: SessionState;
  const opened: unknown[] = [];
  window.open = ((...args: unknown[]) => { opened.push(args); return null; }) as any;
  function Probe() { state = useSession(); return null; }
  await fixture.render(createElement(Probe));
  const socket = () => ServerSocket.all.at(-1)!;
  const receive = async (message: unknown) => act(async () => socket().receive(message));
  return {
    state: () => state,
    socket,
    opened,
    receive,
    async open() { await act(async () => socket().open()); },
    async reconnect() {
      const connected = new Promise<void>((resolve) => { ServerSocket.connected = resolve; });
      act(() => socket().close());
      await connected;
      ServerSocket.connected = undefined;
      await act(async () => socket().open());
    },
    expireStartTimeout: fixture.expireStartTimeout,
    async stop() {
      await fixture.stop();
      expect(ServerSocket.all.every((socket) => socket.readyState === 3)).toBe(true);
      ServerSocket.connected = undefined;
    },
  };
}

test("session client gates disconnected actions and sends exact catalog, option, permission, and elicitation requests", async () => {
  const ui = await client();
  try {
    expect(ui.state().ready).toBe(false);
    expect(ui.state().start(startOptions)).toBe(false);
    expect(await ui.state().reply("offline")).toBe(false);
    act(() => {
      ui.state().stop(); ui.state().setOption("model", "first");
      ui.state().respondPermission("p", "allow"); ui.state().respondElicitation("e", "cancel");
      ui.state().fork(); ui.state().retryBossPreparation();
      ui.state().requestFileDiff("missing", "file");
    });
    expect(ui.socket().sent).toEqual([]);
    await ui.open();
    await ui.receive(hello());
    expect(ui.state()).toMatchObject({ ready: true, defaultProvider: "", capabilities: {}, experience: null, boss: null, continuity: null, ctrlJ: "newline", connectionEpoch: 1 });
    await ui.receive({ kind: "history", session: session(), events: [] });
    expect(document.title).toBe("Demo");
    act(() => {
      ui.state().requestProviderOptions("demo", "/work");
      ui.state().requestProviderCommands("demo", "/work");
      ui.state().requestFiles("/work");
      ui.state().requestFiles("/work", "file");
      ui.state().checkCwd("/work");
      ui.state().setOption("model", "second");
      ui.state().respondPermission("p", "allow");
      ui.state().respondElicitation("e", "accept", { choice: "yes", enabled: true, count: 2 });
      ui.state().respondElicitation("e2", "decline");
      ui.state().stop();
      ui.state().fork();
    });
    expect(ui.socket().sent).toEqual([
      { op: "list-options", provider: "demo", cwd: "/work" },
      { op: "list-commands", provider: "demo", cwd: "/work" },
      { op: "list-files", cwd: "/work" },
      { op: "list-files", cwd: "/work", query: "file" },
      { op: "check-cwd", cwd: "/work" },
      { op: "set-option", sessionId: "session-1", id: "model", value: "second" },
      { op: "permission-response", sessionId: "session-1", requestId: "p", optionId: "allow" },
      { op: "elicitation-response", sessionId: "session-1", requestId: "e", action: "accept", content: { choice: "yes", enabled: true, count: 2 } },
      { op: "elicitation-response", sessionId: "session-1", requestId: "e2", action: "decline" },
      { op: "stop", sessionId: "session-1" }, { op: "fork", sessionId: "session-1" },
    ]);
    expect(ui.state().forkPending).toBe(true);
    await ui.receive({ kind: "session-forked", session: session("fork-1") });
    expect(ui.state().forkPending).toBe(false);
    expect(ui.opened).toEqual([["/s/fork-1", "_blank"]]);
    act(() => ui.state().fork());
    await ui.receive({ kind: "error", op: "fork", message: "Fork failed" });
    expect(ui.state().forkPending).toBe(false);
    ui.socket().readyState = 3;
    act(() => ui.state().fork());
    expect(ui.state().forkPending).toBe(false);
    expect(await ui.state().reply("Disconnected")).toBe(false);
    act(() => ui.state().compose({ attachments: [attachment], error: "Keep the draft" }));
    expect(ui.state()).toMatchObject({ phase: "composer", session: null, composerAttachments: [attachment], lastError: "Keep the draft", connection: null, recovery: null });
    act(() => ui.state().clearError());
    expect(ui.state().lastError).toBe("");
    act(() => ui.state().compose());
    expect(ui.state().composerAttachments).toEqual([]);
  } finally { await ui.stop(); }
});

test("catalog replies replace only their owner, and file diffs preserve revision-correlated success and failure", async () => {
  const ui = await client();
  try {
    await ui.open();
    await ui.receive(hello({ defaultProvider: "demo", keys: { ctrlJ: "menu" }, capabilities: { demo: { options: [], triggers: ["/"] } } }));
    expect(ui.state().ctrlJ).toBe("menu");
    expect(ui.state().defaultProvider).toBe("demo");
    for (const message of [
      { kind: "options-list", provider: "demo", options: [{ id: "model", label: "Model", kind: "select", value: "first" }] },
      { kind: "options-list", provider: "empty" },
      { kind: "model-catalog", options: { other: [] } },
      { kind: "model-catalog", options: null },
      { kind: "model-catalog", options: "invalid" },
      { kind: "commands-list", provider: "demo", groups: [{ trigger: "/", commands: [{ name: "help" }] }] },
      { kind: "commands-list", provider: "empty" },
      { kind: "files-list", cwd: "/work", files: ["a.ts"] },
      { kind: "files-list", cwd: "/empty" },
      { kind: "cwd-check", cwd: "/work", ok: true },
      { kind: "cwd-check", cwd: "/missing", ok: false, message: "Directory is missing" },
    ]) await ui.receive(message);
    expect(ui.state().providerOptions).toEqual({ demo: [{ id: "model", label: "Model", kind: "select", value: "first" }], empty: [], other: [] });
    expect(ui.state().providerCommands).toEqual({ demo: [{ trigger: "/", commands: [{ name: "help" }] }], empty: [] });
    expect(ui.state().filesByCwd).toEqual({ "/work": ["a.ts"], "/empty": [] });
    expect(ui.state().cwdChecks).toEqual({ "/work": { ok: true }, "/missing": { ok: false, message: "Directory is missing" } });
    await ui.receive({ kind: "history", session: session(), events: [] });
    const first = fileDiffCacheKey("1", "a.ts");
    const second = fileDiffCacheKey("2", "a.ts");
    act(() => {
      ui.state().requestFileDiff("session-1", first);
      ui.state().requestFileDiff("session-1", second);
    });
    expect(ui.socket().sent.slice(-2)).toEqual([
      { op: "get-file-diff", sessionId: "session-1", path: "a.ts" },
      { op: "get-file-diff", sessionId: "session-1", path: "a.ts" },
    ]);
    await ui.receive({ kind: "file-diff", sessionId: "another", path: "a.ts", diff: "wrong" });
    expect(ui.state().fileDiffs).toEqual({});
    await ui.receive({ kind: "file-diff", sessionId: "session-1", path: "a.ts", diff: "first revision" });
    await ui.receive({ kind: "error", op: "get-file-diff", path: "a.ts" });
    expect(ui.state().fileDiffs).toEqual({ [first]: "first revision", [second]: "Failed to load diff" });
    await ui.receive({ kind: "file-diff", sessionId: "session-1", path: "no-request" });
    await ui.receive({ kind: "error", op: "get-file-diff", path: "direct", message: "No diff" });
    expect(ui.state().fileDiffs).toMatchObject({ "no-request": "", direct: "No diff" });
    act(() => {
      ui.state().requestFileDiff("session-1", first);
      ui.state().requestFileDiff("session-1", second);
    });
    await ui.receive({ kind: "error", op: "get-file-diff", path: "a.ts", message: "first failed" });
    await ui.receive({ kind: "file-diff", sessionId: "session-1", path: "a.ts", diff: "second success" });
    expect(ui.state().fileDiffs).toMatchObject({ [first]: "first failed", [second]: "second success" });
    for (const path of ["", null, 7]) await ui.receive({ kind: "error", op: "get-file-diff", path });
    const applied: unknown[] = [];
    document.documentElement.style.setProperty = (name, value) => { applied.push([name, value]); };
    await ui.receive({ kind: "theme", vars: { "--bg": "#abcdef" }, theme: { background: "#abcdef", foreground: "#ffffff", palette: [], opacity: 1 } });
    await ui.receive({ kind: "theme", vars: null });
    await ui.receive({ kind: "theme", vars: "invalid" });
    expect(applied).toContainEqual(["--bg", "#abcdef"]);
    await ui.receive({ kind: "unknown-message" });
    await ui.receive({ kind: "no-session" });
    expect(ui.state()).toMatchObject({ phase: "composer", session: null, fileDiffs: {}, options: [], actions: {}, commands: [], restore: null });
    expect(location.pathname).toBe("/");
  } finally { await ui.stop(); }
});

test("history and live events preserve transcript boundaries, recovery facts, latest options, and duplicate user messages", async () => {
  const ui = await client();
  const options = [{ id: "model", label: "Model", kind: "select", value: "second" }];
  const restore = { kind: "workbench-restore", facts: null, unresolved: [], assessment: "pending" };
  try {
    await ui.open();
    await ui.receive(hello());
    const events = [
      { kind: "options", options: [], actions: { fork: false } },
      { kind: "recovery", mode: "resumed", title: "Resumed", message: "Same session" },
      { kind: "commands", trigger: "/", commands: [{ name: "old" }] },
      { kind: "commands", trigger: "/", commands: [{ name: "new" }] },
      { kind: "commands", trigger: "$", commands: [] },
      { kind: "options", options, actions: { fork: true } }, restore,
      { kind: "capabilities", image: "supported" },
      { kind: "connection", state: "starting", title: "Connecting" },
      { kind: "user", text: "hello" },
      { kind: "delta", text: "stream" },
      { kind: "delta", text: " continued" },
      { kind: "assistant", text: "complete" },
      { kind: "thinking", text: "consider" },
      { kind: "thinking", text: " more" },
      { kind: "tool-start", toolId: "t", name: "" },
      { kind: "tool-end", toolId: "t", detail: "output", ok: false },
      { kind: "tool-end", toolId: "unknown", ok: true },
      { kind: "tool-end", toolId: "t" },
      { kind: "files-changed", files: [{ path: "a.ts", adds: 1, dels: 0, status: "modified" }] },
      { kind: "files-changed", files: [] },
      { kind: "plan", entries: [{ content: "Verify", status: "pending" }] },
      { kind: "permission-request", requestId: "p", title: "Read?", options: [] },
      { kind: "permission-resolved", requestId: "p", optionId: "allow" },
      { kind: "elicitation-request", requestId: "e", message: "Choose", fields: [] },
      { kind: "elicitation-resolved", requestId: "e", action: "cancel" },
      { kind: "status", text: "Working" },
      { kind: "error", message: "Visible error" },
      { kind: "done", stats: "Finished" },
    ];
    await ui.receive({ kind: "history", session: session(), events });
    expect(ui.state()).toMatchObject({ imageCapability: "supported", options, actions: { fork: true }, commands: [{ trigger: "/", commands: [{ name: "new" }] }], restore, recovery: { mode: "resumed", title: "Resumed", message: "Same session" }, connection: { state: "starting", title: "Connecting" } });
    expect(ui.state().blocks).toEqual([
      { kind: "user", text: "hello" }, { kind: "assistant", text: "complete", open: false },
      { kind: "thinking", text: "consider more", open: false },
      { kind: "tool", toolId: "t", name: "tool", status: "ok", out: "output" },
      { kind: "files", files: [{ path: "a.ts", adds: 1, dels: 0, status: "modified" }], revision: "1" },
      { kind: "files", files: [], revision: "2" }, { kind: "plan", entries: [{ content: "Verify", status: "pending" }] },
      { kind: "permission", requestId: "p", title: "Read?", options: [], status: "resolved", optionId: "allow" },
      { kind: "elicitation", requestId: "e", message: "Choose", fields: [], status: "resolved", action: "cancel" },
      { kind: "status", text: "Working" }, { kind: "error", text: "Visible error" }, { kind: "footer", text: "Finished" },
    ]);
    await ui.receive({ kind: "event", sessionId: "wrong", evt: { kind: "user", text: "ignored" } });
    expect(ui.state().blocks).toHaveLength(12);
    const live = async (evt: unknown) => ui.receive({ kind: "event", sessionId: "session-1", evt });
    for (const evt of [
      { kind: "connection", state: "starting", title: "Retry", message: "Starting peer" },
      { kind: "recovery", mode: "respawned", title: "Recovered", message: "Same relationship" },
      { kind: "capabilities", image: "unsupported" },
      { ...restore, assessment: "cancelled" },
      { kind: "options", options: [] },
      { kind: "commands", trigger: "/", commands: [] },
    ]) await live(evt);
    expect(ui.state()).toMatchObject({ connection: { state: "starting", title: "Retry", message: "Starting peer" }, recovery: { mode: "respawned", title: "Recovered", message: "Same relationship" }, imageCapability: "unsupported", actions: {}, commands: [], restore: { assessment: "cancelled" } });
    await live({ kind: "connection", state: "ready", title: "Ready" });
    expect(ui.state().connection).toBeNull();
    await live({ kind: "user", text: "again" }); await live({ kind: "user", text: "again" });
    expect(ui.state().blocks.slice(-2)).toEqual([{ kind: "user", text: "again" }, { kind: "user", text: "again" }]);
    act(() => ui.state().fork());
    await live({ kind: "error", message: "Fork rejected" });
    expect(ui.state().forkPending).toBe(false);
    await ui.receive({ kind: "session-status", sessionId: "wrong", status: "running" });
    expect(ui.state().session.status).toBe("idle");
    await ui.receive({ kind: "session-status", sessionId: "session-1", status: "running" });
    expect(ui.state().session.status).toBe("running");
    for (const state of ["ready", "failed"]) {
      await ui.receive({ kind: "history", session: { ...session(), title: "" }, events: [{ kind: "options", options: [] }, { kind: "connection", state, title: "Finished" }] });
      expect(ui.state()).toMatchObject({ connection: null, recovery: null, restore: null, imageCapability: "unknown", options: [], actions: {} });
      expect(document.title).toBe("cmux agent");
    }
  } finally { await ui.stop(); }
});

test("start admission queues correlated replies, consumes only its optimistic echo, and settles acknowledgments once", async () => {
  const ui = await client("https://example.invalid/token/");
  try {
    expect(ui.socket().address).toBe("wss://example.invalid/token/ws");
    await ui.open(); await ui.receive(hello({ experience, defaultProvider: "demo" }));
    await ui.receive({ kind: "boss-capabilities", image: "supported" });
    act(() => expect(ui.state().start(startOptions)).toBe(true));
    const request = ui.socket().sent.find((message) => message.op === "start");
    expect(request).toEqual({ op: "start", requestId: expect.any(String), ...startOptions });
    expect(document.title).toBe("Boss");
    expect(ui.state()).toMatchObject({ phase: "chat", session: { id: `pending-${request.requestId}`, status: "running" }, blocks: [{ kind: "user", text: "Read this image\n[Image: photo.png]" }] });
    expect(ui.state().start(startOptions)).toBe(false);
    let reply: Promise<boolean>;
    act(() => { reply = ui.state().reply("Queued", [attachment]); });
    expect(ui.socket().sent.filter((message) => message.op === "send")).toHaveLength(0);
    await ui.receive({ kind: "session-created", requestId: "unrelated", session: session("wrong") });
    expect(ui.state().session.id).toBe(`pending-${request.requestId}`);
    await ui.receive({ kind: "session-created", requestId: request.requestId, session: session() });
    expect(location.pathname).toBe("/token/s/session-1");
    const sent = ui.socket().sent.at(-1);
    expect(sent).toEqual({ op: "send", sessionId: "session-1", requestId: expect.any(String), prompt: "Queued", attachments: [attachment] });
    await ui.receive({ kind: "event", sessionId: "session-1", evt: { kind: "user", text: "Read this image\n[Image: photo.png]" } });
    expect(ui.state().blocks).toHaveLength(1);
    await ui.receive({ kind: "event", sessionId: "session-1", evt: { kind: "user", text: "Read this image\n[Image: photo.png]" } });
    expect(ui.state().blocks).toHaveLength(2);
    await ui.receive({ kind: "send-accepted", requestId: sent.requestId });
    expect(await reply).toBe(true);
    await ui.receive({ kind: "send-accepted", requestId: sent.requestId });
    await ui.receive({ kind: "send-accepted" });
    let rejected: Promise<boolean>;
    act(() => { rejected = ui.state().reply("Second"); });
    const second = ui.socket().sent.at(-1);
    await ui.receive({ kind: "error", op: "send", requestId: second.requestId, message: "Rejected" });
    expect(await rejected).toBe(false);
    expect(ui.state().lastError).toBe("Rejected");
    let cancelled: Promise<boolean>;
    act(() => { cancelled = ui.state().reply("Cancel"); });
    await ui.receive({ kind: "error", op: "send", requestId: ui.socket().sent.at(-1).requestId, recoveryError: "cancel-failed", message: "Not settled" });
    expect(await cancelled).toBe(false);
    expect(ui.state().lastError).toBeNull();
    await ui.receive({ kind: "error", op: "send" });
    expect(ui.state().lastError).toBe("Failed to send message");
    const before = ui.socket().sent.length;
    act(() => { ui.state().compose(); ui.state().fork(); ui.state().retryBossPreparation(); });
    expect(ui.socket().sent).toHaveLength(before);
    expect(ui.state().session.id).toBe("session-1");
  } finally { await ui.stop(); }
});

test("failed and timed-out starts restore exact drafts, retire late admission, and allow a fresh retry", async () => {
  const ui = await client();
  try {
    await ui.open(); await ui.receive(hello({ experience }));
    act(() => ui.state().start(startOptions));
    const first = ui.socket().sent.at(-1);
    let queued: Promise<boolean>;
    act(() => { queued = ui.state().reply("Queued"); });
    await ui.receive({ kind: "error", op: "start", requestId: "unrelated", message: "Other request" });
    expect(ui.state().phase).toBe("chat");
    await ui.receive({ kind: "error", op: "start", requestId: first.requestId, message: "Cannot start" });
    expect(await queued).toBe(false);
    expect(ui.state()).toMatchObject({ phase: "composer", session: null, composerAttachments: [attachment], lastError: "Cannot start" });
    expect(sessionStorage.getItem("agentui.draft")).toBe(startOptions.prompt);
    await ui.receive({ kind: "error", op: "start", requestId: first.requestId, message: "Duplicate retired failure" });
    expect(ui.state().lastError).toBe("Cannot start");
    await ui.receive({ kind: "session-created", requestId: first.requestId, session: session("late") });
    await ui.receive({ kind: "history", session: session("late"), events: [{ kind: "user", text: "Retired" }] });
    expect(ui.state().session).toBeNull();
    expect(ui.socket().sent.at(-1)).toEqual({ op: "cancel-start", requestId: first.requestId, retire: true });
    act(() => ui.state().start({ provider: "demo", cwd: "/work", prompt: "Retry" }));
    const retry = ui.socket().sent.at(-1);
    await ui.expireStartTimeout();
    expect(ui.state().lastError).toBe("Failed to start agent: request timed out");
    expect(ui.state().composerAttachments).toEqual([]);
    expect(ui.socket().sent.at(-1)).toEqual({ op: "cancel-start", requestId: retry.requestId, retire: true });
    expect(sessionStorage.getItem("agentui.draft")).toBe("Retry");
    act(() => ui.state().start({ provider: "demo", cwd: "/work", prompt: "Offline timeout" }));
    ui.socket().readyState = 3;
    await ui.expireStartTimeout();
    expect(ui.state().lastError).toBe("Failed to start agent: request timed out");
    expect(sessionStorage.getItem("agentui.draft")).toBe("Offline timeout");
    await ui.receive({ kind: "error", op: "start" });
    expect(ui.state().lastError).toBe("");
  } finally { await ui.stop(); }
});

test("Stop before Boss admission retires the request without replay and restores a server-confirmed canonical session", async () => {
  const ui = await client();
  try {
    await ui.open(); await ui.receive(hello({ experience }));
    act(() => ui.state().start(startOptions));
    const first = ui.socket().sent.at(-1);
    act(() => ui.state().stop());
    expect(ui.socket().sent.at(-1)).toEqual({ op: "cancel-start", requestId: first.requestId, retire: true });
    expect(ui.state().start({ ...startOptions, prompt: "Do not replace the retiring start" })).toBe(false);
    await ui.receive({ kind: "start-retired", requestId: "unknown", sessionId: "wrong" });
    expect(ui.state().session.id).toBe(`pending-${first.requestId}`);
    await ui.reconnect();
    expect(ui.socket().sent).toEqual([{ op: "cancel-start", requestId: first.requestId, retire: true }]);
    await ui.receive({ kind: "start-retired", requestId: first.requestId });
    expect(ui.state()).toMatchObject({ phase: "composer", composerAttachments: [attachment], lastError: "" });
    act(() => ui.state().start(startOptions));
    const next = ui.socket().sent.at(-1);
    act(() => ui.state().stop());
    await ui.receive({ kind: "start-retired", requestId: next.requestId, sessionId: "canonical" });
    expect(ui.socket().sent.at(-1)).toEqual({ op: "subscribe", sessionId: "canonical" });
    expect(location.pathname).toBe("/s/canonical");
    await ui.receive({ kind: "history", session: session("canonical"), events: [] });
    expect(ui.state().session.id).toBe("canonical");
    await ui.receive({ kind: "session-created", requestId: first.requestId, session: session("late-again") });
    expect(ui.state().session.id).toBe("canonical");
  } finally { await ui.stop(); }
});

test("ordinary pending starts replay unchanged after reconnect and Stop does not claim Boss retirement", async () => {
  const ui = await client();
  try {
    await ui.open(); await ui.receive(hello());
    act(() => ui.state().start({ provider: "demo", cwd: "/work", prompt: "Initial" }));
    const request = ui.socket().sent.at(-1);
    act(() => ui.state().stop());
    expect(ui.socket().sent.at(-1)).toEqual({ op: "cancel-start", requestId: request.requestId });
    await ui.reconnect();
    expect(ui.socket().sent).toEqual([request]);
    let queued: Promise<boolean>;
    act(() => { queued = ui.state().reply("Queued offline"); });
    ui.socket().readyState = 3;
    await ui.receive({ kind: "session-created", requestId: request.requestId, session: session() });
    expect(await queued).toBe(false);
    await ui.open();
    expect(ui.socket().sent.slice(-2)).toEqual([{ op: "subscribe", sessionId: "session-1" }, { op: "warm-boss" }]);
    await ui.receive({ kind: "session-created", session: { ...session("new"), title: "" } });
    expect(ui.state()).toMatchObject({ session: { id: "new" }, blocks: [], connection: null });
    expect(document.title).toBe("cmux agent");
    await ui.receive({ kind: "start-retired" });
    expect(ui.state().session.id).toBe("new");
  } finally { await ui.stop(); }
});

for (const locale of ["en", "ja-JP"]) test(`Boss preparation failure, capability loss, and Retry preserve the input priority in ${locale}`, async () => {
  const ui = await client("http://example.invalid", locale);
  const target = window;
  try {
    await ui.open();
    await ui.receive(hello({ experience, continuity: { appInstanceId: "app-1", startedAt: "2026-09-11", previousExitClean: false } }));
    expect(ui.socket().sent.at(-1)).toEqual({ op: "warm-boss" });
    await ui.receive({ kind: "boss-capabilities", image: "unknown" });
    expect(ui.state().bossPreparationError).toBe("");
    await ui.receive({ kind: "boss-capabilities", image: "supported" });
    expect(ui.state().imageCapability).toBe("supported");
    await ui.receive({ kind: "boss-capabilities", image: "unknown" });
    expect(ui.state().bossPreparationError).toBe(locale === "en" ? "The Boss connection was lost." : "Boss との接続が失われました。");
    await ui.receive({ kind: "error", op: "warm-boss", message: "Preparation failed" });
    expect(ui.state()).toMatchObject({ bossPreparationError: "Preparation failed", lastError: "Preparation failed", imageCapability: "unknown" });
    act(() => ui.state().retryBossPreparation());
    expect(ui.state()).toMatchObject({ bossPreparationError: "", lastError: "", imageCapability: "unknown" });
    await ui.receive({ kind: "boss-capabilities", image: "unsupported" });
    expect(ui.state().imageCapability).toBe("unsupported");
    act(() => { target.dispatchEvent(new Event("input")); target.dispatchEvent(new Event("pointerdown")); });
    expect(ui.socket().sent.filter((message) => message.op === "user-input")).toHaveLength(1);
    await ui.reconnect();
    expect(ui.socket().sent).toEqual([{ op: "user-input" }]);
    await ui.receive(hello({ experience }));
    act(() => target.dispatchEvent(new Event("paste")));
    expect(ui.socket().sent.filter((message) => message.op === "user-input")).toHaveLength(2);
    await ui.receive({ kind: "history", session: session(), events: [] });
    await ui.receive({ kind: "boss-capabilities", image: "supported" });
    expect(ui.state().imageCapability).toBe("unknown");
    await ui.receive({ kind: "error", op: "warm-boss" });
    expect(ui.state().lastError).toBe("");
    await ui.receive(hello({ experience }));
    expect(ui.socket().sent.at(-1)).toEqual({ op: "warm-boss" });
  } finally { await ui.stop(); }
  for (const type of ["input", "keydown", "compositionstart", "paste", "drop", "change", "pointerdown"]) {
    expect(getEventListeners(target, type)).toHaveLength(0);
  }
});

test("the first canonical session list wins while blocked and missing Boss records never select by recency", async () => {
  for (const boss of [
    null, { status: "none", agent: "demo", skipped: [] },
    { status: "blocked", agent: "demo", skipped: [], reason: "ambiguous", detail: "Two candidates" },
    { status: "canonical", agent: "demo", sessionId: "missing", skipped: [] },
    { status: "canonical", agent: "demo", sessionId: "canonical", skipped: [] },
  ]) {
    const ui = await client();
    try {
      await ui.open(); await ui.receive(hello({ experience, boss }));
      await ui.receive({ kind: "sessions", sessions: [session("newer"), session("canonical")] });
      expect(ui.state().session?.id ?? null).toBe(boss?.sessionId === "canonical" ? "canonical" : null);
      await ui.receive({ kind: "sessions", sessions: [session("newer")] });
      expect(ui.state().session?.id ?? null).toBe(boss?.sessionId === "canonical" ? "canonical" : null);
      if (boss?.status === "blocked") expect(ui.state().lastError).toBe("Boss recovery is blocked (ambiguous): Two candidates");
      await ui.receive({ kind: "boss-state", boss: { status: "blocked", agent: "demo", skipped: [], reason: "missing", detail: "Record unavailable" } });
      expect(ui.state().lastError).toContain("Record unavailable");
      await ui.receive({ kind: "boss-state" });
      expect(ui.state().boss).toBeNull();
    } finally { await ui.stop(); }
  }
});

test("session discovery cannot steal a pending or already open conversation and an unmount rejects outstanding replies", async () => {
  const ui = await client();
  let pending: Promise<boolean>;
  try {
    await ui.open(); await ui.receive(hello());
    await ui.receive({ kind: "boss-capabilities", image: "supported" });
    expect(ui.state().imageCapability).toBe("unknown");
    await ui.receive({ kind: "sessions" });
    expect(ui.state().session).toBeNull();
    act(() => ui.state().start(startOptions));
    await ui.receive({ kind: "sessions", sessions: [session("other")] });
    expect(ui.state().session.id).toMatch(/^pending-/);
    await ui.receive({ kind: "session-created", session: session() });
    act(() => { pending = ui.state().reply("Pending on unmount"); });
  } finally { await ui.stop(); }
  expect(await pending).toBe(false);
});

test("connection close rejects pending sends and a fresh ordinary compose does not keep a stale request", async () => {
  const ui = await client();
  try {
    await ui.open(); await ui.receive(hello());
    await ui.receive({ kind: "history", session: session(), events: [] });
    let pending: Promise<boolean>;
    act(() => { pending = ui.state().reply("Pending on disconnect"); });
    await ui.reconnect();
    expect(await pending).toBe(false);
    expect(ui.socket().sent).toEqual([{ op: "subscribe", sessionId: "session-1" }, { op: "warm-boss" }]);
    act(() => ui.state().compose());
    act(() => ui.state().start({ provider: "demo", cwd: "/work", prompt: "New task" }));
    await ui.receive({ kind: "error", op: "start", message: "Uncorrelated legacy failure" });
    expect(ui.state().phase).toBe("composer");
    expect(sessionStorage.getItem("agentui.draft")).toBe("New task");
  } finally { await ui.stop(); }
});

test("event folding closes streams, preserves unmatched requests, and leaves non-transcript metadata out", () => {
  let blocks: Block[] = [];
  for (const event of [
    { kind: "thinking", text: "Thought" }, { kind: "user", text: "User" }, { kind: "delta", text: "Stream" },
    { kind: "thinking", text: "Next thought" }, { kind: "delta", text: "Next stream" },
    { kind: "done" }, { kind: "assistant", text: "Separate answer" },
  ] as AgentEvent[]) blocks = foldEvent(blocks, event);
  expect(blocks).toEqual([
    { kind: "thinking", text: "Thought", open: false }, { kind: "user", text: "User" },
    { kind: "assistant", text: "Stream", open: false }, { kind: "thinking", text: "Next thought", open: false },
    { kind: "assistant", text: "Next stream", open: false }, { kind: "footer", text: "" },
    { kind: "assistant", text: "Separate answer", open: false },
  ]);
  const requests = [
    { kind: "permission", requestId: "other", title: "Keep", options: [], status: "pending" },
    { kind: "elicitation", requestId: "other", message: "Keep", fields: [], status: "pending" },
  ] as Block[];
  expect(foldEvent(requests, { kind: "permission-resolved", requestId: "missing", optionId: "allow" })).toEqual(requests);
  expect(foldEvent(requests, { kind: "elicitation-resolved", requestId: "missing", action: "decline" })).toEqual(requests);
  for (const evt of [{ kind: "meta" }, { kind: "connection", state: "ready", title: "Ready" }, { kind: "recovery", mode: "resumed", title: "Restored", message: "" }, { kind: "capabilities", image: "supported" }] as AgentEvent[]) {
    expect(foldEvent(blocks, evt)).toBe(blocks);
  }
  expect(latestImageCapability([undefined, { kind: "user", text: "" }] as any)).toBe("unknown");
  expect(resolveProviderSelection([{ id: "off", label: "Off", installed: false }], "old")).toBe("old");
  expect(resolveProviderSelection([{ id: "first", label: "First" }], "", "missing")).toBe("first");
  expect(applyCanonicalBoss([], null, experience)).toBeNull();
  expect(applyCanonicalBoss([], { status: "canonical", agent: "demo", skipped: [] }, experience)).toBeNull();
  const retired = new Set(["first", "second"]);
  rememberRetiredId(retired, "first", 2);
  expect([...retired]).toEqual(["second", "first"]);
  rememberRetiredId(retired, "third", 2);
  expect([...retired]).toEqual(["first", "third"]);
});
