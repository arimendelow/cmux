import { afterAll, beforeAll, expect, test } from "bun:test";
import { act, createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Chat, clearAcknowledgedDraft } from "../src/components/Chat";
import { ImageAttachmentTray } from "../src/components/ImageAttachments";
import { StatusRow } from "../src/components/StatusRow";
import { Blocks } from "../src/components/Transcript";
import { ShortcutOverlay } from "../src/hooks/useKeymap";
import { SessionContext } from "../src/context";
import type { SessionOption, SessionState } from "../src/session";
import { clientFixture, findElement as element } from "./client-fixture";

const globals = new Map<string, PropertyDescriptor | undefined>();
beforeAll(() => {
  for (const [name, value] of Object.entries({
    WebSocket: class { static OPEN = 1; constructor() { throw new Error("Chat must not open a socket"); } },
    fetch: () => { throw new Error("Chat must not fetch"); },
    HTMLElement: class {},
    requestAnimationFrame: (callback: FrameRequestCallback) => { callback(0); return 0; },
  })) {
    globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
});
afterAll(() => {
  for (const [name, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

function state(): SessionState {
  return {
    ready: true, connectionEpoch: 1, providers: [{ id: "demo", label: "Demo", installed: true }],
    capabilities: { demo: { options: [], triggers: [], imageAttachments: true } },
    experience: null, boss: null, continuity: null, imageCapability: "supported",
    actionsAllowed: { compose: true, fork: true, delete: true }, connection: null, recovery: null, restore: null,
    providerOptions: {}, session: { id: "session-1", cwd: "/work", title: "Demo", provider: "demo", status: "idle" },
    blocks: [], options: [], actions: { fork: true }, commands: [], filesByCwd: {}, fileDiffs: {},
    lastError: "", ctrlJ: "newline", forkPending: false, reply: async () => true,
    stop() {}, setOption() {}, respondPermission() {}, respondElicitation() {}, fork() {}, compose() {},
    requestProviderOptions() {}, requestProviderCommands() {}, requestFiles() {}, requestFileDiff() {}, clearError() {},
  } as unknown as SessionState;
}
const image = () => new File(["png"], "photo.png", { type: "image/png" });
async function chat(initial: SessionState, attachRefs = false, setup?: () => void) {
  const client = await clientFixture("http://example.invalid");
  setup?.();
  let tree: ReactElement;
  const scroll = { scrollTop: 0, scrollHeight: 500, clientHeight: 100 };
  const input = {
    value: "", selectionStart: 0, selectionEnd: 0, scrollHeight: 220, style: { height: "" },
    focused: 0, focus() { this.focused += 1; }, setSelectionRange(start: number, end: number) { this.selectionStart = start; this.selectionEnd = end; },
  };
  function Probe() {
    tree = Chat();
    if (attachRefs) {
      element(tree, (node) => node.props.id === "messages").props.ref.current = scroll;
      const textarea = element(tree, (node) => node.type === "textarea").props;
      input.value = textarea.value;
      textarea.ref.current = input;
    }
    return null;
  }
  const render = (next: SessionState) => client.render(createElement(SessionContext.Provider, { value: next }, createElement(Probe)));
  await render(initial);
  return {
    render,
    html: () => renderToStaticMarkup(tree),
    textarea: () => element(tree, (node) => node.type === "textarea").props,
    send: () => element(tree, (node) => node.props["aria-label"] === "Send").props,
    row: () => element(tree, (node) => node.type === StatusRow).props,
    tray: () => element(tree, (node) => node.type === ImageAttachmentTray).props,
    messages: () => element(tree, (node) => node.props.id === "messages").props,
    transcript: () => element(tree, (node) => node.type === Blocks).props,
    card: () => element(tree, (node) => node.props.id === "chat-card").props,
    shortcuts: () => element(tree, (node) => node.type === ShortcutOverlay),
    stopButton: () => element(tree, (node) => node.props.id === "stop-btn"),
    scroll, input, stop: client.stop,
  };
}
function key(key: string, rest: Record<string, unknown> = {}) {
  const value = { key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, preventDefault() {}, stopPropagation() {}, ...rest };
  return { ...value, nativeEvent: value };
}

test("a late acknowledgment clears only the draft it accepted, never a newer draft", () => {
  expect(clearAcknowledgedDraft("submitted", "submitted")).toBe("");
  expect(clearAcknowledgedDraft("new draft", "submitted")).toBe("new draft");
  expect(clearAcknowledgedDraft("", "submitted")).toBe("");
  expect(clearAcknowledgedDraft("new draft", "")).toBe("new draft");
});

test("chat admission retains a failed draft and images, prevents duplicate submission, and clears only after acceptance", async () => {
  const context = state();
  const submissions: unknown[] = [];
  let finish: (accepted: boolean) => void;
  context.reply = (text, attachments) => {
    submissions.push({ text, attachments });
    return new Promise((resolve) => { finish = resolve; });
  };
  let clears = 0;
  context.lastError = "Prior failure";
  context.clearError = () => { clears += 1; };
  const ui = await chat(context);
  try {
    expect(ui.send().disabled).toBe(true);
    act(() => ui.send().onClick());
    expect(submissions).toEqual([]);
    act(() => ui.textarea().onChange({ target: { value: "  Inspect image  " } }));
    expect(clears).toBe(1);
    await act(async () => ui.tray().onAdd([image()]));
    const attachments = [...ui.tray().attachments];
    act(() => ui.send().onClick());
    expect(submissions).toEqual([{ text: "Inspect image", attachments }]);
    expect(ui.textarea().disabled).toBe(true);
    expect(ui.row().disabled).toBe(true);
    expect(ui.tray().locked).toBe(true);
    expect(ui.send().disabled).toBe(true);
    act(() => ui.send().onClick());
    expect(submissions).toHaveLength(1);
    await act(async () => finish(false));
    expect(ui.textarea().value).toBe("  Inspect image  ");
    expect(ui.tray().attachments).toEqual(attachments);
    expect(ui.row().disabled).toBe(false);
    act(() => ui.send().onClick());
    await act(async () => finish(true));
    expect(ui.textarea().value).toBe("");
    expect(ui.tray().attachments).toEqual([]);
    expect(submissions).toHaveLength(2);
  } finally { await ui.stop(); }
});

test("chat preserves text after capability loss and supports image-only replies without enabling forbidden actions", async () => {
  const context = state();
  const submissions: unknown[] = [];
  context.reply = async (text, attachments) => { submissions.push({ text, attachments }); return true; };
  const ui = await chat(context);
  try {
    await act(async () => ui.tray().onAdd([image()]));
    expect(ui.send().disabled).toBe(false);
    await act(async () => ui.send().onClick());
    expect(submissions[0]).toMatchObject({ text: "", attachments: [expect.objectContaining({ name: "photo.png" })] });
    act(() => ui.textarea().onChange({ target: { value: "Keep text" } }));
    await act(async () => ui.tray().onAdd([image()]));
    await ui.render({ ...context, imageCapability: "unknown" });
    expect(ui.tray().attachments).toEqual([]);
    expect(ui.tray().error).toContain("does not support image attachments");
    expect(ui.textarea().value).toBe("Keep text");
    expect(ui.send().disabled).toBe(false);
    await ui.render({ ...context, imageCapability: "unsupported", actionsAllowed: { compose: false, fork: false, delete: false } });
    expect(ui.send().disabled).toBe(true);
    expect(ui.transcript().actions).toEqual({});
    act(() => ui.send().onClick());
    expect(submissions).toHaveLength(1);
    await ui.render({ ...context, session: { ...context.session, id: "pending-start", status: "running" } });
    expect(ui.tray().locked).toBe(true);
    expect(ui.stopButton()).not.toBeNull();
  } finally { await ui.stop(); }
});

test("chat gives native restoration precedence over connection and provider recovery while preserving transcript actions", async () => {
  const context = state();
  const diffRequests: unknown[] = [];
  context.requestFileDiff = (...args) => { diffRequests.push(args); };
  context.experience = {
    productName: "Workbench", surfaceName: "Boss", defaultProvider: "demo",
    localAuthorityLabel: "Controlled here", externalAuthority: { label: "External", status: "unknown" },
  };
  context.restore = { kind: "workbench-restore", facts: null, unresolved: [], assessment: "pending" };
  context.connection = { state: "starting", title: "Connecting", message: "Waiting for peer" };
  context.recovery = { mode: "resumed", title: "Resumed", message: "Same conversation" };
  const ui = await chat(context);
  try {
    expect(ui.html()).toContain("Recovery assessment is pending.");
    expect(ui.html()).not.toContain("Waiting for peer");
    expect(ui.html()).not.toContain("Same conversation");
    expect(ui.html()).toContain("App-wide");
    act(() => ui.transcript().onFileDiff("a.ts"));
    expect(diffRequests).toEqual([["session-1", "a.ts"]]);
    expect(ui.transcript().onPermissionResponse).toBe(context.respondPermission);
    expect(ui.transcript().onElicitationResponse).toBe(context.respondElicitation);
    expect(ui.transcript().onFork).toBe(context.fork);
    await ui.render({ ...context, restore: null });
    expect(ui.html()).toContain("Waiting for peer");
    await ui.render({ ...context, restore: null, connection: { state: "starting", title: "Connecting" } });
    expect(ui.html()).toContain("Connecting");
    expect(ui.html()).not.toContain("Waiting for peer");
    await ui.render({ ...context, restore: null, connection: null });
    expect(ui.html()).toContain("Same conversation");
    await ui.render({ ...context, restore: null, connection: null, recovery: null, session: null });
    expect(ui.row().provider).toBe("agent");
    expect(ui.row().cwd).toBe("");
    const help = Object.assign(new Event("keydown", { cancelable: true }), key("/", { ctrlKey: true }));
    act(() => window.dispatchEvent(help));
    expect(ui.shortcuts().props.provider).toBe("agent");
    act(() => ui.shortcuts().props.onClose());
    act(() => ui.transcript().onFileDiff("ignored.ts"));
    act(() => ui.row().onProviderModelChange("demo", "model"));
    expect(diffRequests).toHaveLength(1);
  } finally { await ui.stop(); }
});

test("chat provider switching transfers drafts and images only to capable providers", async () => {
  const context = state();
  context.providers.push({ id: "other", label: "Other" }, { id: "text", label: "Text only" });
  context.capabilities.other = { options: [], triggers: [], imageAttachments: true };
  const transfers: unknown[] = [];
  context.compose = (value) => transfers.push(value);
  const ui = await chat(context);
  try {
    act(() => ui.textarea().onChange({ target: { value: "Keep this draft" } }));
    await act(async () => ui.tray().onAdd([image()]));
    const attachments = [...ui.tray().attachments];
    act(() => ui.row().onProviderModelChange("other", "model"));
    expect(transfers.at(-1)).toEqual({ attachments });
    expect(localStorage.getItem("agentui.provider")).toBe("other");
    expect(localStorage.getItem("agentui.cwd")).toBe("/work");
    expect(sessionStorage.getItem("agentui.draft")).toBe("Keep this draft");
    act(() => ui.row().onProviderModelChange("text", "model"));
    expect(transfers.at(-1)).toEqual({ attachments: [], error: "Staged images were removed because the provider does not support image attachments." });
    await ui.render({ ...context, actionsAllowed: { ...context.actionsAllowed, compose: false } });
    act(() => ui.row().onProviderModelChange("other", "different"));
    expect(transfers).toHaveLength(2);
    act(() => ui.tray().onRemove(attachments[0].id));
    await ui.render(context);
    act(() => ui.row().onProviderModelChange("text", ""));
    expect(transfers.at(-1)).toEqual({ attachments: [] });
    act(() => ui.row().onProviderModelChange("demo", ""));
    expect(transfers).toHaveLength(3);
  } finally { await ui.stop(); }
});

test("model restoration waits for matching options and restores only valid model-scoped stored values", async () => {
  const context = state();
  const model: SessionOption = { id: "model", label: "Model", kind: "select", value: "old", choices: [{ value: "old", label: "Old" }, { value: "new", label: "New" }] };
  const effort: SessionOption = { id: "effort", label: "Effort", role: "effort", kind: "select", value: "low", choices: [{ value: "low", label: "Low" }, { value: "high", label: "High" }] };
  const fast: SessionOption = { id: "fastMode", label: "Fast", kind: "toggle", value: false };
  context.options = [model, effort, fast];
  const changes: unknown[] = [];
  context.setOption = (id, value) => { changes.push([id, value]); };
  const ui = await chat(context, false, () => {
    localStorage.setItem("agentui.opts.demo", JSON.stringify({
      version: 2, model: "old", harness: {}, models: { new: { effort: "high", fastMode: true, context: "unavailable" } },
    }));
  });
  try {
    act(() => ui.row().onProviderModelChange("demo", "new"));
    expect(changes).toEqual([["model", "new"]]);
    await ui.render({ ...context, options: [] });
    expect(changes).toHaveLength(1);
    await ui.render({ ...context, options: [model] });
    expect(changes).toHaveLength(1);
    await ui.render({ ...context, options: [
      { ...model, value: "new" }, effort, fast,
      { id: "context", label: "Context", kind: "select", value: "small", choices: [{ value: "small", label: "Small" }] },
    ] });
    expect(changes).toEqual([["model", "new"], ["effort", "high"], ["fastMode", true]]);
    await ui.render({ ...context, options: [{ ...model, value: "new" }, { ...effort, value: "high" }, { ...fast, value: true }] });
    expect(changes).toHaveLength(3);
    act(() => ui.row().onProviderModelChange("demo", "new"));
    await ui.render({ ...context, options: [{ ...model, value: "new" }, { ...effort, value: "high" }] });
    expect(changes).toHaveLength(4);
  } finally { await ui.stop(); }
});

test("chat scrolling follows new content only near the bottom and keyboard preserves commands, Stop, and help", async () => {
  const context = state();
  context.session = { ...context.session, status: "running" };
  context.commands = [{ trigger: "/", commands: [{ name: "review" }] }];
  let stops = 0;
  let sends = 0;
  context.stop = () => { stops += 1; };
  context.reply = async () => { sends += 1; return true; };
  const ui = await chat(context, true);
  try {
    expect(ui.scroll.scrollTop).toBe(500);
    expect(ui.input.style.height).toBe("200px");
    ui.scroll.scrollTop = 0;
    act(() => ui.messages().onScroll());
    ui.scroll.scrollHeight = 600;
    await ui.render({ ...context, blocks: [{ kind: "user", text: "Additional content" }] });
    expect(ui.scroll.scrollTop).toBe(0);
    ui.scroll.scrollTop = 450;
    act(() => ui.messages().onScroll());
    ui.scroll.scrollHeight = 650;
    await ui.render({ ...context, blocks: [{ kind: "user", text: "More content" }] });
    expect(ui.scroll.scrollTop).toBe(650);
    act(() => ui.textarea().onChange({ target: { value: "/rev" } }));
    ui.input.selectionStart = 4; ui.input.selectionEnd = 4;
    act(() => ui.textarea().onSelect());
    act(() => ui.textarea().onKeyDown(key("Enter")));
    expect(ui.textarea().value).toBe("/review ");
    expect(sends).toBe(0);
    act(() => ui.textarea().onKeyDown(key("j", { ctrlKey: true })));
    expect(ui.textarea().value).toBe("/review \n");
    act(() => ui.textarea().onKeyDown(key("Enter", { shiftKey: true })));
    act(() => ui.textarea().onKeyDown(key("x")));
    expect(sends).toBe(0);
    await act(async () => ui.textarea().onKeyDown(key("Enter")));
    expect(sends).toBe(1);
    act(() => ui.stopButton().props.onClick());
    expect(stops).toBe(1);
    const help = Object.assign(new Event("keydown", { cancelable: true }), key("/", { ctrlKey: true }));
    act(() => window.dispatchEvent(help));
    expect(ui.shortcuts()).not.toBeNull();
    act(() => ui.shortcuts().props.onClose());
    expect(ui.shortcuts()).toBeNull();
    const model = Object.assign(new Event("keydown", { cancelable: true }), key("P", { ctrlKey: true, shiftKey: true }));
    act(() => window.dispatchEvent(model));
    expect(ui.row().openOptionId).toBe("modelPicker");
    const drop = { dataTransfer: { files: [image()], items: [], types: [] }, preventDefault() {}, stopPropagation() {} };
    act(() => ui.card().onDragEnter(drop));
    expect(ui.card().className).toBe("image-drop-active");
  } finally { await ui.stop(); }
});
