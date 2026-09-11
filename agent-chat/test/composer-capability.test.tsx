import { expect, test } from "bun:test";
import { act, createElement, isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionContext } from "../src/context";
import { Composer } from "../src/components/Composer";
import { ImageAttachmentTray } from "../src/components/ImageAttachments";
import type { SessionState } from "../src/session";
import { clientFixture } from "./client-fixture";

function element(tree: any, matches: (node: ReactElement<any>) => boolean): ReactElement<any> {
  if (Array.isArray(tree)) {
    for (const child of tree) { const found = element(child, matches); if (found) return found; }
  } else if (isValidElement<any>(tree)) {
    if (matches(tree)) return tree;
    return element([tree.props.children, tree.props.trailing], matches);
  }
  return null;
}

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

async function composerFixture(state: SessionState) {
  const client = await clientFixture("http://example.invalid");
  localStorage.setItem("agentui.provider", state.defaultProvider);
  localStorage.setItem("agentui.cwd", "/example");
  let tree: ReactElement;
  // Keep the component's real hooks and returned event handlers; no DOM nodes are mounted.
  function Probe() { tree = Composer(); return null; }
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
  test(`initial Boss ${capability} capability disables picker, drop, and paste without navigating`, async () => {
    const ui = await composerFixture(context(capability));
    try {
      expect(ui.html()).not.toContain("+ Image");
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
    expect(ui.html()).not.toContain("+ Image");
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

test("ordinary non-Boss composers retain their existing static image behavior", async () => {
  const ui = await composerFixture(context("unknown", false));
  try {
    expect(ui.html()).toContain("+ Image");
    const dropped = fileEvent();
    await act(async () => ui.drop().onDrop(dropped.event));
    expect(dropped.prevented()).toBe(true);
    expect(ui.tray().attachments).toHaveLength(1);
    expect(ui.submit().disabled).toBe(false);
  } finally { await ui.stop(); }
});
