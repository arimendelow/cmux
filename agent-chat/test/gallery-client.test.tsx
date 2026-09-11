import { afterAll, beforeAll, expect, test } from "bun:test";
import { act, createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GalleryApp } from "../src/gallery";
import { HarnessModelPicker, StatusRow } from "../src/components/StatusRow";
import { CmdkMenu } from "../src/components/CmdkMenu";
import { Blocks, ElicitationBlock, PermissionBlock, TurnActions } from "../src/components/Transcript";
import { clientFixture, findElement as element } from "./client-fixture";

const nativeSocket = globalThis.WebSocket;
const nativeFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.WebSocket = class { static OPEN = 1; constructor() { throw new Error("Gallery must not create live sessions"); } } as any;
  globalThis.fetch = (() => { throw new Error("Gallery must not contact a provider"); }) as any;
});
afterAll(() => {
  globalThis.WebSocket = nativeSocket;
  globalThis.fetch = nativeFetch;
});

function examples(tree: ReactElement, matches: (node: ReactElement<any>) => boolean) {
  const found: ReactElement<any>[] = [];
  for (;;) {
    const next = element(tree, (node) => matches(node) && !found.includes(node));
    if (!next) return found;
    found.push(next);
  }
}

test("gallery viewport controls change the retained frame and preserve its navigation and synthetic examples", async () => {
  const client = await clientFixture("http://example.invalid");
  let tree: ReactElement;
  function Probe() { tree = GalleryApp(); return null; }
  try {
    await client.render(createElement(Probe));
    const html = renderToStaticMarkup(tree);
    expect(html).toContain("Agent Chat Gallery");
    expect(html).toContain("No WebSocket, no provider process, no live sessions.");
    expect(html).toContain("Blocked Boss recovery");
    expect(html).toContain("Conversation resumed");
    expect(html).toContain("Permission request");
    expect(html).toContain("Structured question");
    expect(html).toContain("Virtualization stress transcript");
    const links = examples(tree, (node) => node.type === "a");
    expect(links).toHaveLength(14);
    for (const link of links) expect(html).toContain(`id="${link.props.href.slice(1)}"`);
    const viewports = examples(tree, (node) => node.type === "button" && /px$/.test(node.props.children));
    expect(viewports.map((node) => node.props.children)).toEqual(["320px", "480px", "660px", "900px", "1120px", "1400px"]);
    for (const viewport of viewports) {
      act(() => viewport.props.onClick());
      expect(element(tree, (node) => node.props.className === "gallery-viewport-frame").props.style.maxWidth).toBe(viewport.props.children);
      expect(element(tree, (node) => node.type === "button" && node.props.children === viewport.props.children).props.className).toBe("active");
    }
    expect(location.href).toBe("http://example.invalid/");
  } finally { await client.stop(); }
});

test("gallery status example updates only its local option state and model picks remain diagnostic", async () => {
  const client = await clientFixture("http://example.invalid");
  let gallery: ReactElement;
  let demo: ReactElement;
  let selected: ReactElement<any>;
  const log = console.log;
  const messages: unknown[] = [];
  function GalleryProbe() { gallery = GalleryApp(); return null; }
  function DemoProbe() { demo = (selected.type as Function)(selected.props); return null; }
  try {
    await client.render(createElement(GalleryProbe));
    selected = element(gallery, (node) => node.props.provider === "claude" && typeof node.type === "function");
    expect(selected).not.toBeNull();
    await client.render(createElement(DemoProbe));
    const row = () => element(demo, (node) => node.type === StatusRow).props;
    const before = row().options.find((option) => option.id === "model").value;
    act(() => row().onChange("effort", "low"));
    expect(row().options.find((option) => option.id === "effort").value).toBe("low");
    expect(row().options.find((option) => option.id === "model").value).toBe(before);
    expect(renderToStaticMarkup(demo)).toContain("Low");
    console.log = (...args) => { messages.push(args); };
    act(() => row().onProviderModelChange("codex", "gpt-5.5"));
    expect(messages).toEqual([["gallery model", "codex", "gpt-5.5"]]);
    expect(row().provider).toBe("claude");
    expect(location.pathname).toBe("/");
  } finally { console.log = log; await client.stop(); }
});

test("gallery command and option examples expose the declared choices without sending provider commands", async () => {
  const client = await clientFixture("http://example.invalid");
  let tree: ReactElement;
  const log = console.log;
  const messages: unknown[] = [];
  function Probe() { tree = GalleryApp(); return null; }
  try {
    await client.render(createElement(Probe));
    const menus = examples(tree, (node) => node.type === CmdkMenu);
    expect(menus).toHaveLength(8);
    const groups = menus.flatMap((node) => node.props.groups);
    expect(groups.map((group) => group.id)).toEqual(["effort", "context", "permissionMode", "approvals", "sandbox", "/", "$", "@", "empty"]);
    expect(groups.find((group) => group.id === "empty").items).toEqual([]);
    expect(groups.find((group) => group.id === "@").items[0].label).toBe("@src/App.tsx");
    expect(groups.find((group) => group.id === "$").items[0].label).toBe("$security");
    console.log = (...args) => { messages.push(args); };
    for (const id of ["effort", "context", "permissionMode", "approvals", "sandbox", "/", "$", "@"]) {
      const item = groups.find((group) => group.id === id).items[0];
      act(() => item.onSelect());
      expect(messages.at(-1)).toEqual([
        ["approvals", "sandbox"].includes(id) ? "gallery overflow" : ["/", "$", "@"].includes(id) ? "gallery command" : "gallery option",
        id,
        ["/", "$", "@"].includes(id) ? item.label.slice(1) : item.id.slice(id.length + 1),
      ]);
    }
    expect(location.pathname).toBe("/");
  } finally { console.log = log; await client.stop(); }
});

test("gallery permission, question, and enabled fork examples remain local and do not mutate the illustrated conversation", async () => {
  const client = await clientFixture("http://example.invalid");
  let gallery: ReactElement;
  let question: ReactElement<any>;
  let forkTree: ReactElement;
  let current: ReactElement<any>;
  const log = console.log;
  const messages: unknown[] = [];
  function GalleryProbe() { gallery = GalleryApp(); return null; }
  function QuestionProbe() { question = ElicitationBlock(current.props as any); return null; }
  function ForkProbe() {
    const blocks = Blocks(current.props as any);
    const group = element(blocks, (node) => Boolean(node.props.group?.footer));
    const turn = (group.type as Function)(group.props);
    forkTree = TurnActions(element(turn, (node) => node.type === TurnActions).props as any);
    return null;
  }
  function StandaloneForkProbe() { forkTree = TurnActions(current.props as any); return null; }
  try {
    await client.render(createElement(GalleryProbe));
    const permission = element(gallery, (node) => node.type === PermissionBlock);
    const permissionTree = PermissionBlock(permission.props as any);
    const permissionBefore = renderToStaticMarkup(permissionTree);
    act(() => element(permissionTree, (node) => node.type === "button" && node.props.children === "Allow once").props.onClick());
    expect(renderToStaticMarkup(PermissionBlock(permission.props as any))).toBe(permissionBefore);
    expect(permissionBefore).toContain('data-permission-status="pending"');
    current = element(gallery, (node) => node.type === ElicitationBlock);
    await client.render(createElement(QuestionProbe));
    act(() => element(question, (node) => node.type === "select").props.onChange({ target: { value: "conservative" } }));
    expect(element(question, (node) => node.type === "select").props.value).toBe("conservative");
    act(() => question.props.onSubmit({ preventDefault() {} }));
    expect(question.props["data-elicitation-status"]).toBe("pending");
    expect(location.pathname).toBe("/");
    console.log = (...args) => { messages.push(args); };
    const transcriptExamples = examples(gallery, (node) => node.type === Blocks && node.props.blocks.some((block) => block.kind === "footer"));
    expect(transcriptExamples).toHaveLength(6);
    for (const transcript of transcriptExamples) {
      current = transcript;
      const before = JSON.stringify(current.props.blocks);
      await client.render(createElement(ForkProbe));
      const button = element(forkTree, (node) => node.props.className === "turn-menu-item");
      expect(button.props.disabled).toBe(false);
      act(() => button.props.onClick());
      expect(JSON.stringify(current.props.blocks)).toBe(before);
      expect(location.pathname).toBe("/");
    }
    expect(messages).toEqual([["gallery fork"]]);
    const actionExamples = examples(gallery, (node) => node.type === TurnActions);
    expect(actionExamples).toHaveLength(3);
    for (const action of actionExamples) {
      current = action;
      await client.render(createElement(StandaloneForkProbe));
      const button = element(forkTree, (node) => node.props.className === "turn-menu-item");
      expect(button.props.disabled).toBe(Boolean(action.props.forkPending));
      if (!button.props.disabled) act(() => button.props.onClick());
    }
    expect(messages).toEqual([["gallery fork"], ["gallery fork"], ["gallery fork"]]);
  } finally { console.log = log; await client.stop(); }
});

test("the static composer keeps option controls diagnostic and does not open a live model picker", async () => {
  const client = await clientFixture("http://example.invalid");
  let gallery: ReactElement;
  let row: ReactElement;
  let current: ReactElement<any>;
  const log = console.log;
  const messages: unknown[] = [];
  function GalleryProbe() { gallery = GalleryApp(); return null; }
  function MockProbe() {
    const mock = (current.type as Function)(current.props);
    row = StatusRow(element(mock, (node) => node.type === StatusRow).props as any);
    return null;
  }
  try {
    await client.render(createElement(GalleryProbe));
    current = element(gallery, (node) => node.props.state === "error");
    await client.render(createElement(MockProbe));
    const picker = () => element(row, (node) => node.type === HarnessModelPicker).props;
    expect(picker().open).toBe(false);
    act(() => picker().onOpenChange(true));
    expect(picker().open).toBe(false);
    const fast = element(row, (node) => node.props["aria-label"] === "Fast mode");
    expect(fast).not.toBeNull();
    console.log = (...args) => { messages.push(args); };
    act(() => fast.props.onClick());
    expect(messages).toEqual([["gallery composer option", "fastMode", false]]);
    expect(location.pathname).toBe("/");
  } finally { console.log = log; await client.stop(); }
});
