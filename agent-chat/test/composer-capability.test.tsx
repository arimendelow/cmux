import { expect, test } from "bun:test";
import { act, createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionContext } from "../src/context";
import { Composer } from "../src/components/Composer";
import { ImageAttachmentTray } from "../src/components/ImageAttachments";
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

async function composerFixture(state: SessionState, locale = "en") {
  const client = await clientFixture("http://example.invalid", undefined, locale);
  localStorage.setItem("agentui.provider", state.defaultProvider);
  localStorage.setItem("agentui.cwd", "/example");
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
