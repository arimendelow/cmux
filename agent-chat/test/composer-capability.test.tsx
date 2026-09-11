import { afterAll, beforeAll, expect, test } from "bun:test";
import { act, createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionContext } from "../src/context";
import { Composer } from "../src/components/Composer";
import { ImageAttachmentTray } from "../src/components/ImageAttachments";
import { StatusRow } from "../src/components/StatusRow";
import { ShortcutOverlay } from "../src/hooks/useKeymap";
import type { SessionState } from "../src/session";
import { clientFixture, findElement as element } from "./client-fixture";

function context(imageCapability: SessionState["imageCapability"], workbench = true): SessionState {
  const provider = workbench ? "ouro-boss" : "example-acp";
  const noop = () => {};
  return {
    ready: true,
    connectionEpoch: 1,
    providers: [{ id: provider, label: "Example agent", installed: true }],
    capabilities: { [provider]: { options: [], triggers: [], imageAttachments: true } },
    defaultCwd: "/example",
    defaultProvider: provider,
    experience: workbench ? {
      productName: "Workbench", surfaceName: "Boss", defaultProvider: provider,
      localAuthorityLabel: "Controlled here", externalAuthority: { label: "External", status: "unknown" },
    } : null,
    imageCapability,
    providerOptions: {}, providerCommands: {}, filesByCwd: {}, cwdChecks: {},
    lastError: "", composerAttachments: [], ctrlJ: "newline",
    requestProviderOptions: noop, requestProviderCommands: noop, requestFiles: noop,
    checkCwd: noop, clearError: noop, start: () => true,
  } as unknown as SessionState;
}

async function composerFixture(state: SessionState, locale = "en", setup?: () => void) {
  const client = await clientFixture("http://example.invalid", undefined, locale);
  localStorage.setItem("agentui.provider", state.defaultProvider);
  localStorage.setItem("agentui.cwd", "/example");
  setup?.();
  let tree: ReactElement;
  let tray: ReactElement;
  // Keep the component's real hooks and returned event handlers; no DOM nodes are mounted.
  function Probe() {
    tree = Composer();
    tray = ImageAttachmentTray(element(tree, (node) => node.type === ImageAttachmentTray).props as any);
    return null;
  }
  const render = async (next: SessionState) => client.render(
    createElement(SessionContext.Provider, { value: next }, createElement(Probe)),
  );
  await render(state);
  return {
    render,
    html: () => renderToStaticMarkup(tree),
    textarea: () => element(tree, (node) => node.type === "textarea").props,
    tray: () => element(tree, (node) => node.type === ImageAttachmentTray).props,
    drop: () => element(tree, (node) => node.props.id === "composer-card").props,
    submit: () => element(tree, (node) => node.props["aria-label"] === "Start").props,
    retry: () => element(tray, (node) => node.type === "button" && ["Retry", "再試行"].includes(node.props.children)),
    row: () => element(tree, (node) => node.type === StatusRow).props,
    shortcuts: () => element(tree, (node) => node.type === ShortcutOverlay),
    stop: client.stop,
  };
}

function fileEvent() {
  const image = new File(["png"], "example.png", { type: "image/png" });
  const transfer = { files: [image], items: [{ kind: "file" }], types: ["Files"], dropEffect: "" };
  let prevented = false;
  return {
    image,
    event: { dataTransfer: transfer, clipboardData: transfer, preventDefault() { prevented = true; }, stopPropagation() {} },
    prevented: () => prevented,
  };
}

for (const capability of ["unknown", "unsupported"] as const) {
  test(`initial Boss ${capability} capability explains its disabled picker before any file input`, async () => {
    const ui = await composerFixture(context(capability));
    try {
      expect(ui.html()).toContain("+ Image");
      expect(ui.html()).toMatch(/class="attach-image"[^>]*disabled=""/);
      expect(ui.html()).toMatch(/type="file"[^>]*disabled=""/);
      expect(ui.html()).toContain('role="status"');
      expect(ui.html()).toContain(capability === "unknown"
        ? "Connecting to Boss. Checking image support"
        : "This runtime did not advertise image support. You can still send text.");
      expect(ui.tray().enabled).toBe(false);
      const dropped = fileEvent();
      await act(async () => ui.drop().onDrop(dropped.event));
      expect(dropped.prevented()).toBe(true);
      const pasted = fileEvent();
      await act(async () => ui.textarea().onPaste(pasted.event));
      expect(pasted.prevented()).toBe(true);
      await act(async () => ui.tray().onAdd([fileEvent().image]));
      expect(ui.tray().attachments).toEqual([]);
    } finally { await ui.stop(); }
  });
}

test("initial Boss keeps its draft and staged images while capability is unknown, then reenables submission", async () => {
  const state = context("supported");
  const ui = await composerFixture(state);
  try {
    act(() => ui.textarea().onChange({ target: { value: "Keep my draft." } }));
    await act(async () => ui.tray().onAdd([fileEvent().image]));
    expect(ui.tray().attachments).toHaveLength(1);
    await ui.render({ ...state, imageCapability: "unknown" });
    expect(ui.textarea().value).toBe("Keep my draft.");
    expect(ui.tray().attachments).toHaveLength(1);
    expect(ui.submit().disabled).toBe(true);
    expect(ui.html()).toMatch(/class="attach-image"[^>]*disabled=""/);
    await ui.render({ ...state, imageCapability: "supported" });
    expect(ui.html()).toContain("+ Image");
    expect(ui.tray().attachments).toHaveLength(1);
    expect(ui.submit().disabled).toBe(false);
  } finally { await ui.stop(); }
});

test("a definitive unsupported result releases staged images but keeps the initial Boss text draft", async () => {
  const state = context("supported");
  const ui = await composerFixture(state);
  try {
    act(() => ui.textarea().onChange({ target: { value: "Keep the text." } }));
    await act(async () => ui.tray().onAdd([fileEvent().image]));
    await ui.render({ ...state, imageCapability: "unsupported" });
    expect(ui.tray().attachments).toEqual([]);
    expect(ui.textarea().value).toBe("Keep the text.");
    expect(ui.submit().disabled).toBe(false);
  } finally { await ui.stop(); }
});

test("initial Boss images remain removable while unknown, but text waits for a known capability", async () => {
  const state = context("supported");
  let submitted: unknown;
  state.start = (value) => { submitted = value; return true; };
  const ui = await composerFixture(state);
  try {
    act(() => ui.textarea().onChange({ target: { value: "Keep the text." } }));
    await act(async () => ui.tray().onAdd([fileEvent().image]));
    await ui.render({ ...state, imageCapability: "unknown" });
    expect(ui.html()).toContain('aria-label="Remove example.png"');
    expect(ui.html()).toMatch(/class="attach-image"[^>]*disabled=""/);
    act(() => ui.tray().onRemove(ui.tray().attachments[0].id));
    expect(ui.tray().attachments).toEqual([]);
    expect(ui.submit().disabled).toBe(true);
    act(() => ui.submit().onClick());
    expect(submitted).toBeUndefined();
    await ui.render({ ...state, imageCapability: "unsupported" });
    expect(ui.submit().disabled).toBe(false);
    act(() => ui.submit().onClick());
    expect(submitted).toMatchObject({ prompt: "Keep the text.", attachments: [] });
  } finally { await ui.stop(); }
});

test("unknown initial Boss capability blocks text-only click and Enter without losing the draft", async () => {
  const state = context("unknown");
  const submitted: unknown[] = [];
  state.start = (value) => { submitted.push(value); return true; };
  const ui = await composerFixture(state);
  try {
    act(() => ui.textarea().onChange({ target: { value: "Keep this draft until connected." } }));
    expect(ui.submit().disabled).toBe(true);
    act(() => ui.submit().onClick());
    act(() => ui.textarea().onKeyDown({ key: "Enter", shiftKey: false, preventDefault() {} }));
    expect(submitted).toEqual([]);
    expect(ui.textarea().value).toBe("Keep this draft until connected.");
    await ui.render({ ...state, imageCapability: "supported" });
    expect(ui.submit().disabled).toBe(false);
    expect(ui.html()).not.toMatch(/class="attach-image"[^>]*disabled=""/);
    act(() => ui.submit().onClick());
    expect(submitted).toEqual([expect.objectContaining({
    prompt: "Keep this draft until connected.", attachments: [],
    })]);
  } finally { await ui.stop(); }
});

for (const capability of ["unknown", "unsupported"] as const) {
  test(`initial Boss explains ${capability} image capability in Japanese`, async () => {
    const ui = await composerFixture(context(capability), "ja-JP");
    try {
      expect(ui.html()).toContain("+ 画像");
      expect(ui.html()).toContain(capability === "unknown"
        ? "Boss に接続しています。画像への対応を確認しています。"
        : "このランタイムは画像への対応を通知していません。テキストは送信できます。");
      expect(ui.html()).toMatch(/class="attach-image"[^>]*disabled=""/);
      act(() => ui.textarea().onChange({ target: { value: "この下書きを保持します。" } }));
      expect(ui.submit().disabled).toBe(capability === "unknown");
    } finally { await ui.stop(); }
  });
}

for (const capability of ["unknown", "unsupported", "supported"] as const) {
  test(`ordinary non-Boss composers keep text and images available with ${capability} negotiation`, async () => {
    const state = context(capability, false);
    const ui = await composerFixture(state);
    try {
      act(() => ui.textarea().onChange({ target: { value: "Ordinary text stays available." } }));
      expect(ui.submit().disabled).toBe(false);
      expect(ui.html()).toContain("+ Image");
      expect(ui.html()).not.toMatch(/class="attach-image"[^>]*disabled=""/);
      expect(ui.html()).not.toContain("Checking image support");
      expect(ui.html()).not.toContain("did not advertise image support");
      const dropped = fileEvent();
      await act(async () => ui.drop().onDrop(dropped.event));
      expect(dropped.prevented()).toBe(true);
      expect(ui.tray().attachments).toHaveLength(1);
      expect(ui.submit().disabled).toBe(false);
    } finally { await ui.stop(); }
  });
}

for (const locale of ["en", "ja-JP"]) test(`failed initial negotiation explains Retry in ${locale}`, async () => {
  let retries = 0;
  const reason = "Synthetic initialization failure.";
  const state = {
    ...context("unknown"),
    bossPreparationError: reason,
    retryBossPreparation: () => { retries += 1; },
  };
  const ui = await composerFixture(state, locale);
  try {
    act(() => ui.textarea().onChange({ target: { value: "Keep this failed negotiation draft." } }));
    expect(ui.html()).toContain(reason);
    expect(ui.html()).toContain(locale === "en" ? "Could not check image support." : "画像への対応を確認できませんでした。");
    expect(ui.html()).not.toContain(locale === "en" ? "Connecting to Boss." : "Boss に接続しています。");
    expect(ui.retry()).not.toBeNull();
    expect(ui.retry().props.children).toBe(locale === "en" ? "Retry" : "再試行");
    expect(ui.retry().props.type).toBe("button");
    expect(ui.submit().disabled).toBe(true);
    act(() => ui.retry().props.onClick());
    expect(retries).toBe(1);
    expect(ui.textarea().value).toBe("Keep this failed negotiation draft.");
  } finally { await ui.stop(); }
});

test("ordinary composer ignores Boss preparation failures and retry callbacks", async () => {
  let retries = 0;
  const state = {
    ...context("unknown", false),
    bossPreparationError: "Synthetic Boss-only failure.",
    retryBossPreparation: () => { retries += 1; },
  };
  const ui = await composerFixture(state);
  try {
    act(() => ui.textarea().onChange({ target: { value: "Ordinary text remains available." } }));
    expect(ui.html()).not.toContain(state.bossPreparationError);
    expect(ui.retry()).toBeNull();
    expect(ui.submit().disabled).toBe(false);
    expect(retries).toBe(0);
  } finally { await ui.stop(); }
});

const clientGlobals = new Map<string, PropertyDescriptor | undefined>();
beforeAll(() => {
  for (const [name, value] of Object.entries({
    WebSocket: class { static OPEN = 1; constructor() { throw new Error("Composer must not open a socket"); } },
    fetch: () => { throw new Error("Composer must not fetch"); },
    HTMLElement: class {},
    requestAnimationFrame: (callback: FrameRequestCallback) => { callback(0); return 0; },
  })) {
    clientGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
});
afterAll(() => {
  for (const [name, descriptor] of clientGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

test("composer retains a rejected start, trims the submitted text and cwd, and clears only accepted images", async () => {
  const state = { ...context("supported", false), lastError: "Prior error", ready: false };
  const submissions: unknown[] = [];
  let cleared = 0;
  let accept = false;
  state.clearError = () => { cleared += 1; };
  state.start = (value) => { submissions.push(value); return accept; };
  const ui = await composerFixture(state);
  try {
    act(() => ui.textarea().onChange({ target: { value: "  Inspect this  " } }));
    expect(cleared).toBe(1);
    act(() => ui.submit().onClick());
    expect(submissions).toEqual([]);
    await ui.render({ ...state, ready: true });
    act(() => ui.row().onCwdChange("  /work  "));
    await act(async () => ui.tray().onAdd([fileEvent().image]));
    const attachments = [...ui.tray().attachments];
    act(() => ui.submit().onClick());
    expect(submissions).toEqual([{ provider: state.defaultProvider, cwd: "/work", prompt: "Inspect this", options: {}, attachments }]);
    expect(ui.tray().attachments).toEqual(attachments);
    expect(ui.textarea().value).toBe("  Inspect this  ");
    accept = true;
    act(() => ui.submit().onClick());
    expect(ui.tray().attachments).toEqual([]);
    expect(localStorage.getItem("agentui.provider")).toBe(state.defaultProvider);
    expect(localStorage.getItem("agentui.cwd")).toBe("/work");
  } finally { await ui.stop(); }
});

test("composer restores stored draft and model options, commits cwd, and invalidates images on provider changes", async () => {
  const model = { id: "model", label: "Model", kind: "select" as const, value: "a", choices: [{ value: "a", label: "Alpha" }, { value: "b", label: "Beta" }] };
  const effort = { id: "effort", label: "Effort", role: "effort" as const, kind: "select" as const, value: "low", choices: [{ value: "low", label: "Low" }, { value: "high", label: "High" }] };
  const state = context("supported", false);
  state.providers = [...state.providers, { id: "other", label: "Other", installed: true }, { id: "unlisted", label: "Unlisted", installed: true }];
  state.capabilities.other = { options: [model, effort], triggers: [], imageAttachments: false };
  state.providerOptions[state.defaultProvider] = [model, effort];
  const submissions: unknown[] = [];
  state.start = (value) => { submissions.push(value); return true; };
  const ui = await composerFixture(state, "en", () => {
    sessionStorage.setItem("agentui.draft", "Restored draft");
    localStorage.setItem(`agentui.opts.${state.defaultProvider}`, JSON.stringify({ model: "a", effort: "high", stale: true }));
  });
  try {
    expect(ui.textarea().value).toBe("Restored draft");
    expect(sessionStorage.getItem("agentui.draft")).toBeNull();
    expect(ui.row().options.find((o) => o.id === "effort").value).toBe("high");
    act(() => ui.row().onChange("effort", "low"));
    expect(ui.row().options.find((o) => o.id === "effort").value).toBe("low");
    act(() => ui.row().onCwdCommit("  "));
    expect(localStorage.getItem("agentui.cwd")).toBe("/example");
    act(() => ui.row().onCwdCommit(" /committed "));
    expect(localStorage.getItem("agentui.cwd")).toBe("/committed");
    await act(async () => ui.tray().onAdd([fileEvent().image]));
    act(() => ui.row().onProviderModelChange("other", "b"));
    expect(ui.tray().attachments).toEqual([]);
    expect(ui.tray().error).toContain("provider changed");
    expect(ui.row().provider).toBe("other");
    expect(ui.row().options.find((o) => o.id === "model").value).toBe("b");
    act(() => ui.row().onProviderModelChange("other", "a"));
    expect(ui.row().options.find((o) => o.id === "model").value).toBe("a");
    act(() => ui.submit().onClick());
    expect(submissions.at(-1)).toMatchObject({ provider: "other", prompt: "Restored draft", options: { model: "a" }, attachments: [] });
    act(() => ui.row().onProviderModelChange("unlisted", "missing"));
    act(() => ui.submit().onClick());
    expect(submissions.at(-1)).toMatchObject({ provider: "unlisted", options: {} });
  } finally { await ui.stop(); }
});

test("composer keyboard accepts command-menu choices, keeps newline input, and exposes shortcut help", async () => {
  const state = context("supported", false);
  state.providerCommands[state.defaultProvider] = [{ trigger: "/", commands: [{ name: "review", description: "Review this change" }] }];
  let starts = 0;
  state.start = () => { starts += 1; return true; };
  const ui = await composerFixture(state);
  const event = (key: string, extra: Record<string, unknown> = {}) => {
    const value = { key, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, preventDefault() {}, stopPropagation() {}, ...extra };
    return { ...value, nativeEvent: value };
  };
  try {
    act(() => ui.textarea().onChange({ target: { value: "/rev" } }));
    act(() => ui.textarea().onKeyDown(event("Enter")));
    expect(ui.textarea().value).toBe("/review ");
    expect(starts).toBe(0);
    act(() => ui.textarea().onKeyDown(event("j", { ctrlKey: true })));
    expect(ui.textarea().value).toBe("/review \n");
    act(() => ui.textarea().onKeyDown(event("Enter", { shiftKey: true })));
    expect(starts).toBe(0);
    act(() => ui.textarea().onKeyDown(event("x")));
    expect(starts).toBe(0);
    act(() => ui.textarea().onKeyDown(event("Enter")));
    expect(starts).toBe(1);
    const help = Object.assign(new Event("keydown", { cancelable: true }), event("/", { ctrlKey: true }));
    act(() => window.dispatchEvent(help));
    expect(ui.shortcuts()).not.toBeNull();
    act(() => ui.shortcuts().props.onClose());
    expect(ui.shortcuts()).toBeNull();
    const model = Object.assign(new Event("keydown", { cancelable: true }), event("P", { ctrlKey: true, shiftKey: true }));
    act(() => window.dispatchEvent(model));
    expect(ui.row().openOptionId).toBe("modelPicker");
  } finally { await ui.stop(); }
});

test("a fresh composer chooses defaults without a stored provider or draft and has no sendable empty prompt", async () => {
  const state = context("supported", false);
  const ui = await composerFixture(state, "en", () => {
    localStorage.removeItem("agentui.provider");
    localStorage.removeItem("agentui.cwd");
  });
  try {
    expect(ui.row().provider).toBe(state.defaultProvider);
    expect(ui.row().cwd).toBe("/example");
    expect(ui.textarea().value).toBe("");
    expect(ui.submit().disabled).toBe(true);
    await act(async () => ui.tray().onAdd([fileEvent().image]));
    expect(ui.submit().disabled).toBe(false);
    const dropped = fileEvent();
    act(() => ui.drop().onDragEnter(dropped.event));
    expect(ui.drop().className).toBe("image-drop-active");
  } finally { await ui.stop(); }
});

test("Boss preparation errors appear once without hiding a different start failure", async () => {
  const state = {
    ...context("unknown"),
    bossPreparationError: "Preparation could not finish.",
    lastError: "Preparation could not finish.",
  };
  const ui = await composerFixture(state);
  try {
    // The picker also carries the same reason in its title; count visible alerts, not attributes.
    expect(ui.html().match(/<span[^>]+role="alert"[^>]*>[^<]*Preparation could not finish\.<\/span>/g)).toHaveLength(1);
    expect(ui.html()).not.toContain('class="composer-error"');
    await ui.render({ ...state, lastError: "The selected directory is unavailable." });
    expect(ui.html()).toContain(state.bossPreparationError);
    expect(ui.html()).toContain('<div class="composer-error">The selected directory is unavailable.</div>');
    expect(ui.submit().disabled).toBe(true);
  } finally { await ui.stop(); }
});
