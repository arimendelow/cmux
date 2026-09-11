import { afterAll, beforeAll, expect, test } from "bun:test";
import { act, createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Popover } from "@base-ui-components/react/popover";
import { BossStatusBanner } from "../src/components/BossStatusBanner";
import { WorkbenchRestoreBanner } from "../src/components/RecoveryBanner";
import { WorkbenchHeader } from "../src/components/WorkbenchHeader";
import * as icons from "../src/components/icons";
import { CmdkMenu } from "../src/components/CmdkMenu";
import { HarnessModelPicker, OverflowMenu, StatusRow } from "../src/components/StatusRow";
import { actionSupported, ShortcutOverlay, useKeymap } from "../src/hooks/useKeymap";
import type { SessionOption, WorkbenchExperience } from "../src/session";
import { clientFixture, findElement as element } from "./client-fixture";

const saved = new Map<string, PropertyDescriptor | undefined>();
const install = (name: string, value: unknown) => {
  saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
};
class ControlTarget extends EventTarget {
  tagName = "DIV";
  isContentEditable = false;
  rail = false;
  value = "";
  focused = 0;
  focus() { this.focused += 1; }
  closest(selector: string) { return selector === ".model-picker-rail" && this.rail ? this : null; }
}
beforeAll(() => {
  install("WebSocket", class { static OPEN = 1; constructor() { throw new Error("Controls must not open sockets"); } });
  install("fetch", () => { throw new Error("Controls must not fetch"); });
  install("HTMLElement", ControlTarget);
  install("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 0; });
  install("CSS", { escape: (id: string) => id.replaceAll(":", "\\:") });
});
afterAll(() => {
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

function key(key: string, rest: Record<string, unknown> = {}) {
  const event = Object.assign(new Event("keydown", { cancelable: true }), {
    key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, isComposing: false, ...rest,
  });
  return Object.assign(event, { nativeEvent: event });
}
const select = (id: string, value = "a", extra: Partial<SessionOption> = {}): SessionOption => ({
  id, label: id, kind: "select", value,
  choices: [{ value: "a", label: "Alpha" }, { value: "b", label: "Beta" }], ...extra,
});
const experience: WorkbenchExperience = {
  productName: "Workbench", surfaceName: "Boss", defaultProvider: "ouro-boss",
  localAuthorityLabel: "Controlled here", externalAuthority: { label: "External", status: "unknown" },
};

test("blocked Boss with no skipped records stays non-destructive and null Boss is silent", () => {
  expect(renderToStaticMarkup(<BossStatusBanner boss={null} />)).toBe("");
  const html = renderToStaticMarkup(<BossStatusBanner boss={{
    status: "blocked", agent: "demo", reason: "missing", detail: "Exact record is missing", skipped: [],
  }} />);
  expect(html).toContain("Exact record is missing");
  expect(html).toContain("Workbench kept every candidate.");
  expect(html).not.toContain("<ul");
  expect(html).not.toContain("<button");
});

test("compact authority header uses each verified status and the default external link label", () => {
  for (const [status, label] of Object.entries({
    connected: "Connected", disconnected: "Disconnected", stopped: "Stopped",
    unavailable: "Unavailable", unknown: "Status unknown",
  })) {
    const html = renderToStaticMarkup(<WorkbenchHeader compact experience={{
      ...experience, externalAuthority: { label: "External", status: status as any, openUrl: "https://example.invalid" },
    }} />);
    expect(html).toContain('class="workbench-header compact"');
    expect(html).toContain(label);
    expect(html).toContain(">Open</a>");
    expect(html).toContain('rel="noreferrer"');
  }
});

test("native receipt defaults to the current locale and counts unresolved facts without changing them", async () => {
  const client = await clientFixture("http://example.invalid", undefined, "ja-JP");
  const receipt = {
    kind: "workbench-restore" as const, facts: null, unresolved: ["surface-1", "surface-2"],
    assessment: "failed" as const, error: "assessment-failed" as const,
  };
  const before = JSON.stringify(receipt);
  try {
    const html = renderToStaticMarkup(<WorkbenchRestoreBanner receipt={receipt as any} />);
    expect(html).toContain("復元時の未解決項目数: 2");
    expect(html).toContain("復元情報は保持されています。");
    expect(JSON.stringify(receipt)).toBe(before);
  } finally { await client.stop(); }
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  try {
    Reflect.deleteProperty(globalThis, "navigator");
    expect(renderToStaticMarkup(<WorkbenchRestoreBanner receipt={receipt as any} />)).toContain("Unresolved items at restore: 2");
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "navigator", descriptor);
  }
});

test("provider icons select light, dark, and drawn fallbacks without requesting an image", async () => {
  const client = await clientFixture("http://example.invalid");
  try {
    for (const id of ["claude", "codex", "opencode", "pi", "gemini", "copilot", "ouro-boss", "custom"]) {
      const html = renderToStaticMarkup(<icons.ProviderIcon provider={{ id, label: id }} />);
      expect(html).toContain(id === "custom" ? 'class="dot"' : 'class="provider-icon"');
      if (id === "ouro-boss") expect(html).toContain(">O</text>");
      if (id === "copilot") expect(html).toContain(">C</text>");
    }
    const provider = { id: "demo", label: "Demo", iconUrl: "/light.svg", iconDarkUrl: "/dark.svg" };
    expect(renderToStaticMarkup(<icons.ProviderIcon provider={provider} />)).toContain("/dark.svg");
    expect(renderToStaticMarkup(<icons.ProviderIcon provider={{ ...provider, iconDarkUrl: undefined }} />)).toContain("/light.svg");
    globalThis.getComputedStyle = (() => ({ getPropertyValue: () => " #FFFFFF " })) as any;
    expect(renderToStaticMarkup(<icons.ProviderIcon provider={provider} />)).toContain("/light.svg");
    globalThis.getComputedStyle = (() => ({ getPropertyValue: () => "transparent" })) as any;
    expect(renderToStaticMarkup(<icons.ProviderIcon provider={provider} />)).toContain("/dark.svg");
    expect(icons.colorFor("xyz")).toBe("hsl(33 60% 60%)");
    expect(icons.colorFor("")).toBe("hsl(0 60% 60%)");
    expect(icons.basename("")).toBe("~");
    expect(icons.basename("/")).toBe("~");
    expect(icons.basename("/work/project///")).toBe("project");
    for (const Icon of [icons.ArrowUp, icons.Chevron, icons.Check, icons.FolderIcon, icons.SparkIcon, icons.BoltIcon, icons.PlanIcon, icons.ShieldIcon, icons.EllipsisIcon, icons.SearchIcon, icons.CopyIcon]) {
      expect(renderToStaticMarkup(<Icon />)).toContain("<svg");
    }
    expect(renderToStaticMarkup(<icons.BarsIcon />).match(/opacity="1"/g)).toHaveLength(4);
    expect(renderToStaticMarkup(<icons.BarsIcon filled={0} bars={0} />)).toContain('opacity="0.35"');
    expect(renderToStaticMarkup(<icons.BarsIcon filled={9} bars={2} />).match(/opacity="1"/g)).toHaveLength(2);
    expect(renderToStaticMarkup(<icons.PinwheelSpinner />)).toContain('width="14"');
    expect(renderToStaticMarkup(<icons.PinwheelSpinner size={20} />).match(/<line/g)).toHaveLength(8);
  } finally { await client.stop(); }
});

test("shortcut support follows actual kinds, roles, disabled states, and available choices", () => {
  const options: SessionOption[] = [
    select("mode", "build", { choices: [{ value: "build", label: "Build" }, { value: "plan", label: "Plan" }] }),
    select("model"), select("effort", "a", { role: "effort" }),
    { id: "fastMode", label: "Fast", kind: "toggle", value: false },
  ];
  for (const action of ["cycle-mode", "cycle-model", "open-model", "cycle-thinking", "toggle-fast", "toggle-plan"] as const) {
    expect(actionSupported(action, options, false)).toBe(true);
    expect(actionSupported(action, [], false)).toBe(false);
    expect(actionSupported(action, options.map((o) => ({ ...o, disabled: true })), false)).toBe(false);
  }
  expect(actionSupported("help", [], false)).toBe(true);
  expect(actionSupported("interrupt", [], false)).toBe(false);
  expect(actionSupported("interrupt", [], true)).toBe(true);
  expect(actionSupported("unknown" as any, options, true)).toBe(false);
  expect(actionSupported("cycle-mode", [select("approvals")], false)).toBe(true);
  expect(actionSupported("cycle-thinking", [select("thinking", "off", { role: "effort", choices: [{ value: "off", label: "Off" }] })], false)).toBe(false);
  expect(actionSupported("toggle-plan", [select("permissionMode", "default", { choices: [{ value: "plan", label: "Plan" }] })], false)).toBe(true);
  expect(actionSupported("toggle-plan", [select("mode", "", { choices: undefined })], false)).toBe(false);
  for (const id of ["model", "mode", "effort"]) {
    const wrongKind = { id, label: id, kind: "toggle" as const, value: false, role: id === "effort" ? "effort" as const : undefined };
    expect(actionSupported(id === "model" ? "open-model" : id === "mode" ? "cycle-mode" : "cycle-thinking", [wrongKind], false)).toBe(false);
  }
});

test("real key listeners cycle options, toggle plan and fast mode, close help, and respect admission locks", async () => {
  const client = await clientFixture("http://example.invalid");
  const target = window;
  const changes: unknown[] = [];
  let stops = 0;
  let opens = 0;
  let help = false;
  const input = new ControlTarget();
  input.tagName = "TEXTAREA";
  let props: Parameters<typeof useKeymap>[0] = {
    options: [select("model"), select("permissionMode"), select("effort", "a", { role: "effort" }), { id: "fastMode", label: "Fast", kind: "toggle", value: false }],
    setOption: (id, value) => changes.push([id, value]), running: true, stop: () => { stops += 1; },
    helpOpen: false, setHelpOpen: (value) => { help = value; }, popupOpen: false,
    closePopup: () => { throw new Error("Menu dispatch belongs to the popup"); }, ctrlJ: "newline",
    inputRef: { current: input as any }, openModel: () => { opens += 1; },
  };
  function Probe() { useKeymap(props); return null; }
  const render = async (next: Partial<typeof props> = {}) => {
    props = { ...props, ...next };
    await client.render(createElement(Probe));
  };
  const dispatch = (event: Event) => act(() => window.dispatchEvent(event));
  try {
    await render();
    dispatch(key("Tab", { shiftKey: true }));
    for (const value of ["M", "T", "F", "P"]) dispatch(key(value, { ctrlKey: true, shiftKey: true }));
    expect(changes).toEqual([["permissionMode", "b"], ["model", "b"], ["effort", "b"], ["fastMode", true]]);
    expect(opens).toBe(1);
    dispatch(key("Escape"));
    expect(stops).toBe(1);
    dispatch(key("?"));
    expect(help).toBe(true);
    await render({ helpOpen: true });
    dispatch(key("Escape"));
    expect(help).toBe(false);
    expect(stops).toBe(1);
    await render({ helpOpen: false, disabled: true });
    const blocked = key("M", { ctrlKey: true, shiftKey: true });
    dispatch(blocked);
    expect(blocked.defaultPrevented).toBe(false);
    dispatch(key("Escape"));
    expect(stops).toBe(2);
    await render({ disabled: false, running: false });
    const idle = key("Escape");
    dispatch(idle);
    expect(idle.defaultPrevented).toBe(false);
    input.value = "Draft";
    const question = key("?");
    dispatch(question);
    expect(question.defaultPrevented).toBe(false);
    await render({ inputRef: { current: null } });
    dispatch(key("/", { ctrlKey: true }));
    expect(help).toBe(true);
    const unmatched = key("x");
    dispatch(unmatched);
    expect(unmatched.defaultPrevented).toBe(false);
    await render({ popupOpen: true, ctrlJ: "menu" });
    const menu = key("j", { ctrlKey: true });
    dispatch(menu);
    expect(menu.defaultPrevented).toBe(false);
    await render({ popupOpen: false });
    for (const options of [
      [], [select("model", "a", { disabled: true })],
      [select("model", "", { choices: [] })],
      [{ id: "model", label: "Model", value: true, kind: "toggle" as const }],
    ]) {
      await render({ options });
      const count = changes.length;
      dispatch(key("M", { ctrlKey: true, shiftKey: true }));
      dispatch(key("T", { ctrlKey: true, shiftKey: true }));
      dispatch(key("F", { ctrlKey: true, shiftKey: true }));
      dispatch(key("L", { ctrlKey: true, shiftKey: true }));
      expect(changes.length).toBe(count);
    }
    for (const [id, value, fallback] of [["mode", "plan", "build"], ["permissionMode", "plan", "default"], ["mode", "default", "plan"]]) {
      await render({ options: [select(id, value, { choices: [{ value: "plan", label: "Plan" }, ...(fallback === "build" ? [{ value: "build", label: "Build" }] : [])] })] });
      dispatch(key("L", { ctrlKey: true, shiftKey: true }));
      expect(changes.at(-1)).toEqual([id, fallback]);
    }
    await render({ options: [select("mode", "plan", { disabled: true, choices: [{ value: "plan", label: "Plan" }] })] });
    const count = changes.length;
    dispatch(key("L", { ctrlKey: true, shiftKey: true }));
    expect(changes.length).toBe(count);
    await render({ options: [select("model", "missing")] });
    dispatch(key("M", { ctrlKey: true, shiftKey: true }));
    expect(changes.at(-1)).toEqual(["model", "a"]);
  } finally { await client.stop(); }
  const detached = key("Escape");
  target.dispatchEvent(detached);
  expect(stops).toBe(2);
  expect(detached.defaultPrevented).toBe(false);
});

test("shortcut overlay labels unavailable actions and keeps backdrop and panel clicks distinct", () => {
  let closed = 0;
  let stopped = 0;
  const tree = ShortcutOverlay({ provider: "Demo", options: [], running: false, ctrlJ: "newline", onClose: () => { closed += 1; } });
  const html = renderToStaticMarkup(tree);
  expect(html).toContain("Demo shortcuts");
  expect(html).toContain('class="shortcut-row disabled"');
  expect(html).not.toContain("Next menu item while a menu is open");
  element(tree, (node) => node.props.className === "shortcut-panel").props.onMouseDown({ stopPropagation() { stopped += 1; } });
  expect(stopped).toBe(1);
  expect(closed).toBe(0);
  tree.props.onMouseDown();
  expect(closed).toBe(1);
  expect(renderToStaticMarkup(<ShortcutOverlay provider="Demo" options={[select("model")]} running ctrlJ="menu" onClose={() => {}} />)).toContain("Next menu item while a menu is open");
});

test("status controls preserve option payloads, working directory commits, and disabled admission scope", async () => {
  const client = await clientFixture("http://example.invalid");
  const changes: unknown[] = [];
  const opened: unknown[] = [];
  const commits: string[] = [];
  const cwdChanges: string[] = [];
  try {
    const options = [
      select("effort", "a", { role: "effort" }), select("context"),
      { id: "fastMode", label: "Fast", kind: "toggle" as const, value: false },
      { id: "approve", label: "Approve", role: "approval" as const, kind: "toggle" as const, value: true },
      select("mode", "plan", { choices: [{ value: "plan", label: "Plan" }, { value: "build", label: "Build" }] }),
      { id: "extra", label: "Extra", kind: "toggle" as const, value: false },
      select("other"), select("no-choices", "", { choices: undefined }),
    ];
    const props: Parameters<typeof StatusRow>[0] = {
      provider: "demo", providers: [{ id: "demo", label: "Demo" }], cwd: "/work",
      options, onChange: (id, value) => changes.push([id, value]),
      onCwdChange: (value) => cwdChanges.push(value), onCwdCommit: (value) => commits.push(value),
      openOptionId: "effort", setOpenOptionId: (id) => opened.push(id),
      running: true, trailing: <button id="stop">Stop</button>,
    };
    let tree = StatusRow({ ...props, disabled: true });
    expect(element(tree, (node) => node.props.className === "status-row-controls").props.inert).toBe(true);
    expect(element(tree, (node) => node.props.className === "status-row-controls").props["aria-disabled"]).toBe(true);
    expect(element(tree, (node) => node.props.id === "stop")).not.toBeNull();
    tree = StatusRow(props);
    expect(element(tree, (node) => node.props.className === "status-row-controls").props.inert).toBeUndefined();
    expect(renderToStaticMarkup(tree)).toContain("provider-running");
    for (const label of ["Fast", "Approve"]) element(tree, (node) => node.props["aria-label"] === label).props.onClick();
    expect(changes).toEqual([["fastMode", true], ["approve", false]]);
    element(tree, (node) => node.type === "button" && node.props.className === "row-control").props.onClick();
    expect(changes.at(-1)).toEqual(["mode", "build"]);
    const inline = element(tree, (node) => node.props.option?.id === "effort");
    const inlineTree = (inline.type as Function)(inline.props);
    const menu = element(inlineTree, (node) => node.type === CmdkMenu);
    menu.props.groups[0].items[1].onSelect();
    expect(changes.at(-1)).toEqual(["effort", "b"]);
    expect(renderToStaticMarkup(menu.props.groups[0].items[0].icon)).toContain("<svg");
    inline.props.onOpenChange(false);
    inline.props.onOpenChange(true);
    expect(opened).toEqual([null, "effort"]);
    const context = element(tree, (node) => node.props.option?.id === "context");
    context.props.onOpenChange(true);
    context.props.onOpenChange(false);
    const contextMenu = element((context.type as Function)(context.props), (node) => node.type === CmdkMenu);
    expect(contextMenu.props.groups[0].items[0].icon).toBeUndefined();
    const cwdNode = element(tree, (node) => node.props.cwd === "/work" && node.props.onCommit);
    const cwdTree = (cwdNode.type as Function)(cwdNode.props);
    cwdTree.props.onOpenChange(true);
    expect(commits).toEqual([]);
    cwdTree.props.onOpenChange(false);
    const input = element(cwdTree, (node) => node.type === "input").props;
    input.onChange({ target: { value: "/new" } });
    input.onBlur({ target: { value: "/blur" } });
    let blurred = 0;
    input.onKeyDown({ key: "x", target: { value: "/ignored" } });
    input.onKeyDown({ key: "Enter", target: { value: "/enter", blur() { blurred += 1; } } });
    expect(cwdChanges).toEqual(["/new"]);
    expect(commits).toEqual(["/work", "/blur", "/enter"]);
    expect(blurred).toBe(1);
    const overflow = element(tree, (node) => node.type === OverflowMenu);
    const groups = element(OverflowMenu(overflow.props as any), (node) => node.type === CmdkMenu).props.groups;
    for (const group of groups) for (const item of group.items) item.onSelect();
    expect(changes).toContainEqual(["extra", true]);
    expect(changes).toContainEqual(["other", "b"]);
    expect(OverflowMenu({ options: [], onChange() {} })).toBeNull();
    const on = OverflowMenu({ options: [{ id: "x", label: "X", value: true, kind: "toggle", disabled: true }], onChange: (id, value) => changes.push([id, value]) });
    const item = element(on, (node) => node.type === CmdkMenu).props.groups[0].items[0];
    expect(item.description).toBe("Currently on");
    expect(item.disabled).toBe(true);
    const neutral = renderToStaticMarkup(<StatusRow provider="missing" cwd="/" options={[]} onChange={() => {}} openOptionId={null} setOpenOptionId={() => {}} />);
    expect(neutral).toContain("missing");
    expect(neutral).not.toContain("aria-disabled");
    const controls = StatusRow({
      provider: "demo", providers: [], onProviderModelChange() {}, cwd: "", options: [select("effort", "off", { role: "effort" })],
      onChange() {}, openOptionId: null, setOpenOptionId: (id) => opened.push(id),
    });
    const picker = element(controls, (node) => node.type === HarnessModelPicker);
    expect(picker.props.allProviderOptions).toEqual({});
    picker.props.onOpenChange(true);
    picker.props.onOpenChange(false);
    expect(opened.slice(-2)).toEqual(["modelPicker", null]);
    for (const option of [select("context", "", { choices: [] }), select("context", "saved", { choices: [] }), select("context", null as any, { choices: [] })]) {
      const row = StatusRow({ provider: "demo", cwd: "", options: [option], onChange() {}, openOptionId: null, setOpenOptionId() {} });
      const node = element(row, (node) => node.props.option?.id === "context");
      const menu = element((node.type as Function)(node.props), (node) => node.type === CmdkMenu);
      expect(menu.props.groups[0].items.length).toBe(option.value ? 1 : 0);
      expect(menu.props.trigger.props.disabled).toBe(!option.value);
    }
  } finally { await client.stop(); }
});

test("model picker searches, navigates, chooses, and refuses disabled models through its real handlers", async () => {
  const client = await clientFixture("http://example.invalid");
  const choices: unknown[] = [];
  const opened: boolean[] = [];
  let tree: ReactElement;
  let props: Parameters<typeof HarnessModelPicker>[0] = {
    provider: "demo", providers: [
      { id: "demo", label: "Demo" }, { id: "other", label: "Other" }, { id: "blank", label: "Blank" },
      { id: "missing", label: "Missing", installed: false, installCommand: "example install" },
      { id: "unavailable", label: "Unavailable", installed: false },
    ],
    options: [select("model", "a", { choices: [
      { value: "a", label: "Alpha" }, { value: "b", label: "Beta", disabled: true, disabledReason: "Not available" },
      { value: "c", label: "Gamma", disabled: true }, { value: "d", label: "Alpha", description: "Described model" },
    ] })],
    allProviderOptions: { other: [select("model")] },
    open: false, onOpenChange: (value) => opened.push(value), onSelect: (provider, model) => choices.push([provider, model]),
  };
  function Probe() { tree = HarnessModelPicker(props); return null; }
  const render = async (next: Partial<typeof props> = {}) => { props = { ...props, ...next }; await client.render(createElement(Probe)); };
  const find = (matches: (node: ReactElement<any>) => boolean) => element(tree, matches);
  const row = (id: string) => find((node) => node.props.id === id);
  const search = () => find((node) => node.props.role === "combobox");
  const popup = () => find((node) => node.type === Popover.Popup);
  const change = async (value: string) => act(() => search().props.onChange({ target: { value } }));
  const press = (value: string, target = new ControlTarget(), rest: Record<string, unknown> = {}) => {
    const event = key(value, rest);
    Object.defineProperty(event, "target", { value: target });
    act(() => popup().props.onKeyDown(event));
    return event;
  };
  try {
    await render();
    act(() => find((node) => node.type === Popover.Root).props.onOpenChange(true));
    await render({ open: true });
    expect(row("demo:a").props["aria-selected"]).toBe(true);
    expect(row("demo:b").props.disabled).toBe(true);
    expect(row("demo:c").props.children[1].props.children[1].props.children).toBe("Unavailable");
    press("ArrowDown");
    expect(search().props["aria-activedescendant"]).toBe("demo:b");
    press("Enter");
    expect(choices).toEqual([]);
    act(() => row("demo:d").props.onMouseEnter());
    expect(search().props["aria-activedescendant"]).toBe("demo:d");
    act(() => row("demo:d").props.onClick());
    expect(choices).toEqual([["demo", "d"]]);
    expect(opened.at(-1)).toBe(false);
    await render({ open: true, running: true });
    const searchTarget = new ControlTarget();
    const railTarget = new ControlTarget();
    railTarget.rail = true;
    search().props.ref.current = searchTarget;
    find((node) => node.props.role === "tablist").props.ref.current = { querySelector: () => railTarget };
    let scrolled = "";
    find((node) => node.props.role === "listbox").props.ref.current = {
      querySelector(selector: string) { scrolled = selector; return { scrollIntoView(options: unknown) { expect(options).toEqual({ block: "nearest" }); } }; },
    };
    press("ArrowDown");
    expect(scrolled).toBe("#demo\\:a");
    press("ArrowUp");
    expect(search().props["aria-activedescendant"]).toBe("demo:d");
    expect(press("Tab").defaultPrevented).toBe(true);
    expect(railTarget.focused).toBeGreaterThan(0);
    press("Tab", railTarget);
    expect(searchTarget.focused).toBeGreaterThan(0);
    press("ArrowRight", railTarget);
    expect(row("other:a")).not.toBeNull();
    press("ArrowLeft", railTarget);
    expect(row("demo:a")).not.toBeNull();
    press("ArrowUp", railTarget);
    expect(row("blank:default")).not.toBeNull();
    press("ArrowDown", railTarget);
    expect(row("demo:a")).not.toBeNull();
    act(() => find((node) => node.props.role === "tab" && node.props["aria-label"] === "Blank").props.onClick());
    expect(row("blank:default")).not.toBeNull();
    press("Enter");
    expect(choices.at(-1)).toEqual(["blank", ""]);
    await change("al");
    expect(find((node) => node.props.role === "tablist")).toBeNull();
    expect(row("demo:a")).not.toBeNull();
    expect(row("other:a")).not.toBeNull();
    await change("dpa");
    expect(row("demo:a")).not.toBeNull();
    await change("no-such-model");
    expect(find((node) => node.props.className === "model-picker-empty").props.children).toBe("No models found");
    const before = choices.length;
    press("ArrowDown"); press("ArrowUp"); press("Enter");
    expect(choices.length).toBe(before);
    press("Escape");
    expect(opened.at(-1)).toBe(false);
    await change("");
    const typed = key("D");
    act(() => window.dispatchEvent(typed));
    expect(typed.defaultPrevented).toBe(true);
    expect(search().props.value).toBe("D");
    for (const event of [key("x", { isComposing: true }), key("x", { metaKey: true }), key("x", { ctrlKey: true }), key("x", { altKey: true }), key("Enter")]) {
      act(() => window.dispatchEvent(event));
      expect(search().props.value).toBe("D");
    }
    const prevented = key("x"); prevented.preventDefault();
    act(() => window.dispatchEvent(prevented));
    expect(search().props.value).toBe("D");
    const fromSearch = key("x");
    Object.defineProperty(fromSearch, "target", { value: searchTarget });
    act(() => window.dispatchEvent(fromSearch));
    expect(fromSearch.defaultPrevented).toBe(false);
    act(() => find((node) => node.type === Popover.Root).props.onOpenChange(true));
    expect(search().props.value).toBe("");
    let copied = "";
    Object.assign(navigator, { clipboard: { writeText: async (value: string) => { copied = value; } } });
    await act(async () => find((node) => node.props["aria-label"] === "Missing not installed").props.onClick());
    expect(copied).toBe("example install");
    Object.assign(navigator, { clipboard: { writeText: async () => { throw new Error("Clipboard denied"); } } });
    await act(async () => find((node) => node.props["aria-label"] === "Missing not installed").props.onClick());
    Object.assign(navigator, { clipboard: undefined });
    act(() => find((node) => node.props["aria-label"] === "Missing not installed").props.onClick());
    act(() => find((node) => node.props["aria-label"] === "Unavailable not installed").props.onClick());
    act(() => find((node) => node.type === Popover.Root).props.onOpenChange(false));
    expect(opened.at(-1)).toBe(false);
    await render({ provider: "blank", options: [], open: false });
    act(() => find((node) => node.type === Popover.Root).props.onOpenChange(true));
    const count = choices.length;
    act(() => row("blank:default").props.onClick());
    expect(choices.length).toBe(count);
    await render({ provider: "missing", providers: props.providers.filter((provider) => provider.installed === false), options: [], open: true });
    expect(find((node) => node.props["aria-label"] === "Missing not installed")).not.toBeNull();
    expect(find((node) => node.props.role === "tab")).toBeNull();
    // The install controls remain in the rail even when no harness is installed.
    press("ArrowRight", railTarget);
    press("ArrowUp", railTarget);
    expect(search().props["aria-activedescendant"]).toBeUndefined();
    expect(choices.length).toBe(count);
    await render({ provider: "unknown", providers: [], options: [], open: true });
    expect(search().props["aria-activedescendant"]).toBeUndefined();
    expect(find((node) => node.props.className === "model-picker-empty")).not.toBeNull();
    press("z");
  } finally { await client.stop(); }
});
