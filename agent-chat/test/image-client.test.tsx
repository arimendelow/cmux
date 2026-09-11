import { afterAll, beforeAll, expect, test } from "bun:test";
import { act, createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  canonicalImageFileName,
  ImageAttachmentTray,
  readImageAttachmentForTest,
  useImageAttachments,
} from "../src/components/ImageAttachments";
import { clientFixture, findElement } from "./client-fixture";

const originalSocket = globalThis.WebSocket;
const originalFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.WebSocket = class {
    static OPEN = 1;
    constructor() { throw new Error("Image tests must not open a socket"); }
  } as any;
  globalThis.fetch = (() => { throw new Error("Image tests must not fetch"); }) as any;
});
afterAll(() => {
  globalThis.WebSocket = originalSocket;
  globalThis.fetch = originalFetch;
});

const image = (name = "photo.png") => new File(["png"], name, { type: "image/png" });
function transfer(files: File[] = [], items: { kind: string }[] = [], types: string[] = []) {
  const data = { files, items, types, dropEffect: "" };
  let prevented = false;
  let stopped = false;
  return {
    dataTransfer: data, clipboardData: data,
    preventDefault() { prevented = true; },
    stopPropagation() { stopped = true; },
    prevented: () => prevented,
    stopped: () => stopped,
  };
}

async function images(enabled = true, locked = false) {
  const client = await clientFixture("http://example.invalid");
  let value: ReturnType<typeof useImageAttachments>;
  let tree: ReactElement;
  function Probe(props: { enabled: boolean; locked: boolean }) {
    value = useImageAttachments(props.enabled, undefined, props.locked);
    tree = ImageAttachmentTray({
      ...value, enabled: props.enabled, locked: props.locked,
      onAdd: value.addFiles, onRemove: value.remove,
    });
    return null;
  }
  const render = (enabled: boolean, locked = false) => client.render(createElement(Probe, { enabled, locked }));
  await render(enabled, locked);
  return {
    value: () => value,
    tree: () => tree,
    html: () => renderToStaticMarkup(tree),
    render,
    stop: client.stop,
  };
}

test("image reader preserves each supported MIME type, byte boundaries, and canonical empty names", async () => {
  for (const type of ["image/gif", "image/jpeg", "image/png", "image/webp"]) {
    const bytes = new Uint8Array(0x8001).fill(255);
    const result = await readImageAttachmentForTest(new File([bytes], " ../nested/picture ", { type }));
    expect(result).toMatchObject({ name: "picture", mimeType: type, byteCount: bytes.length });
    expect(Buffer.from(result.data, "base64")).toEqual(Buffer.from(bytes));
  }
  const maximum = new Uint8Array(8 * 1024 * 1024);
  expect((await readImageAttachmentForTest(new File([maximum], "limit.png", { type: "image/png" }))).byteCount).toBe(maximum.length);
  await expect(readImageAttachmentForTest(new File([], "empty.png", { type: "image/png" }))).rejects.toThrow("empty.png must be smaller than 8 MB.");
  expect(canonicalImageFileName("   ")).toBe("image");
  expect(canonicalImageFileName("/nested/")).toBe("image");
});

test("picker previews and removal use the actual selected payload and reset the file input", async () => {
  const ui = await images();
  try {
    const picker = () => findElement(ui.tree(), (node) => node.type === "input").props;
    const attach = () => findElement(ui.tree(), (node) => node.props.className === "attach-image").props;
    let clicks = 0;
    act(() => attach().onClick());
    picker().ref.current = { click() { clicks += 1; } };
    act(() => attach().onClick());
    expect(clicks).toBe(1);
    const target = { files: [image()], value: "photo.png" };
    await act(async () => picker().onChange({ target }));
    expect(target.value).toBe("");
    expect(ui.html()).toContain('src="data:image/png;base64,cG5n"');
    expect(ui.html()).toContain('alt="photo.png"');
    const remove = findElement(ui.tree(), (node) => node.props["aria-label"] === "Remove photo.png");
    act(() => remove.props.onClick());
    expect(ui.value().attachments).toEqual([]);
    const cancelled = { files: null, value: "old" };
    act(() => picker().onChange({ target: cancelled }));
    expect(cancelled.value).toBe("");
    expect(ui.value().attachments).toEqual([]);
  } finally { await ui.stop(); }
});

test("drag and paste distinguish text, file items, file type hints, and actual image bytes", async () => {
  const ui = await images();
  try {
    for (const name of ["onDragEnter", "onDragOver", "onDrop"] as const) {
      const text = transfer([], [{ kind: "string" }], ["text/plain"]);
      act(() => ui.value().dropHandlers[name](text as any));
      expect(text.prevented()).toBe(false);
      expect(ui.value().dragActive).toBe(false);
    }
    const textPaste = transfer([], [{ kind: "string" }], ["text/plain"]);
    act(() => ui.value().onPaste(textPaste as any));
    expect(textPaste.prevented()).toBe(false);
    const hinted = transfer([], [], ["Files"]);
    act(() => ui.value().dropHandlers.onDragEnter(hinted as any));
    expect(hinted.prevented()).toBe(true);
    expect(hinted.stopped()).toBe(true);
    expect(ui.value().dragActive).toBe(true);
    const item = transfer([], [{ kind: "string" }, { kind: "file" }]);
    act(() => ui.value().dropHandlers.onDragOver(item as any));
    expect(item.dataTransfer.dropEffect).toBe("copy");
    act(() => ui.value().dropHandlers.onDragLeave(item as any));
    expect(ui.value().dragActive).toBe(false);
    const dropped = transfer([image()]);
    await act(async () => ui.value().dropHandlers.onDrop(dropped as any));
    expect(dropped.prevented()).toBe(true);
    expect(ui.value().attachments).toHaveLength(1);
    const pasted = transfer([new File(["plain"], "text.txt", { type: "text/plain" }), image("paste.png")]);
    await act(async () => ui.value().onPaste(pasted as any));
    expect(pasted.prevented()).toBe(true);
    expect(ui.value().attachments.map((a) => a.name)).toEqual(["photo.png", "paste.png"]);
    const nonImage = transfer([new File(["plain"], "text.txt", { type: "text/plain" })]);
    act(() => ui.value().onPaste(nonImage as any));
    expect(ui.value().error).toBe("Pasted file is not a supported image type.");
    act(() => ui.value().remove("unknown-id"));
    expect(ui.value().attachments).toHaveLength(2);
    expect(ui.value().error).toBe("");
  } finally { await ui.stop(); }
});

for (const mode of ["unsupported", "locked"] as const) {
  test(`${mode} file input prevents navigation and does not change attachments`, async () => {
    const ui = await images(mode !== "unsupported", mode === "locked");
    try {
      const error = mode === "locked"
        ? "Wait for the current message to be accepted before changing attachments."
        : "This provider does not support image attachments.";
      await act(async () => ui.value().addFiles([]));
      expect(ui.value().error).toBe("");
      await act(async () => ui.value().addFiles([image()]));
      expect(ui.value().error).toBe(error);
      for (const name of ["onDragEnter", "onDragOver", "onDrop"] as const) {
        const event = transfer([image()]);
        act(() => ui.value().dropHandlers[name](event as any));
        expect(event.prevented()).toBe(true);
        expect(event.stopped()).toBe(true);
        expect(ui.value().error).toBe(error);
        expect(ui.value().dragActive).toBe(false);
        if (name === "onDragOver") expect(event.dataTransfer.dropEffect).toBe("none");
      }
      const paste = transfer([image()]);
      act(() => ui.value().onPaste(paste as any));
      expect(paste.prevented()).toBe(true);
      expect(ui.value().attachments).toEqual([]);
      expect(ui.html()).toContain(error);
    } finally { await ui.stop(); }
  });
}

test("concurrent reads reserve four slots, preserve duplicate selections, and release reservations on failure", async () => {
  const ui = await images();
  try {
    let finish: (value: ArrayBuffer) => void;
    const slow = image("slow.png");
    slow.arrayBuffer = () => new Promise<ArrayBuffer>((resolve) => { finish = resolve; });
    let reading: Promise<void>;
    act(() => { reading = ui.value().addFiles([slow]); });
    expect(ui.value().loading).toBe(true);
    expect(ui.html()).toContain("Loading image…");
    await act(async () => ui.value().addFiles([image(), image(), image(), image()]));
    expect(ui.value().error).toBe("Attach up to 4 images per message.");
    await act(async () => ui.value().addFiles([image(), image(), image()]));
    await act(async () => { finish(new TextEncoder().encode("png").buffer); await reading; });
    expect(ui.value().attachments).toHaveLength(4);
    expect(new Set(ui.value().attachments.map((a) => a.id)).size).toBe(4);
    expect(ui.value().loading).toBe(false);
    await act(async () => ui.value().addFiles([image()]));
    expect(ui.value().error).toBe("Attach up to 4 images per message.");
    act(() => ui.value().clear());
    await act(async () => ui.value().addFiles([new File(["bad"], "bad.pdf", { type: "application/pdf" })]));
    expect(ui.value().error).toBe("bad.pdf is not a supported image type.");
    expect(ui.value().loading).toBe(false);
    const failed = image();
    failed.arrayBuffer = () => Promise.reject("Synthetic read failure");
    await act(async () => ui.value().addFiles([failed]));
    expect(ui.value().error).toBe("Synthetic read failure");
    await act(async () => ui.value().addFiles([image()]));
    expect(ui.value().attachments).toHaveLength(1);
    expect(ui.value().error).toBe("");
  } finally { await ui.stop(); }
});

for (const rejected of [false, true]) test(`cleared image batches ignore late ${rejected ? "failure" : "success"} without overwriting the next draft`, async () => {
  const ui = await images();
  try {
    let finish: (value: ArrayBuffer) => void;
    let fail: (reason: Error) => void;
    const slow = image();
    slow.arrayBuffer = () => new Promise<ArrayBuffer>((resolve, reject) => { finish = resolve; fail = reject; });
    let reading: Promise<void>;
    act(() => { reading = ui.value().addFiles([slow]); });
    act(() => ui.value().clear());
    await act(async () => ui.value().addFiles([image("new.png")]));
    await act(async () => {
      if (rejected) fail(new Error("Old failed draft"));
      else finish(new ArrayBuffer(3));
      await reading;
    });
    expect(ui.value().attachments.map((a) => a.name)).toEqual(["new.png"]);
    expect(ui.value().loading).toBe(false);
    expect(ui.value().error).toBe("");
  } finally { await ui.stop(); }
});

test("provider invalidation clears current and pending images but stays silent for an empty draft", async () => {
  const ui = await images();
  try {
    act(() => ui.value().invalidateForUnsupportedProvider("Provider changed"));
    expect(ui.value().error).toBe("");
    let finish: (value: ArrayBuffer) => void;
    const slow = image();
    slow.arrayBuffer = () => new Promise<ArrayBuffer>((resolve) => { finish = resolve; });
    let reading: Promise<void>;
    act(() => { reading = ui.value().addFiles([slow]); });
    act(() => ui.value().invalidateForUnsupportedProvider("Provider changed"));
    expect(ui.value().error).toBe("Provider changed");
    await act(async () => { finish(new ArrayBuffer(3)); await reading; });
    expect(ui.value().attachments).toEqual([]);
    expect(ui.value().loading).toBe(false);
    await act(async () => ui.value().addFiles([image()]));
    act(() => ui.value().invalidateForUnsupportedProvider("Unsupported"));
    expect(ui.value().error).toBe("Unsupported");
    expect(ui.value().attachments).toEqual([]);
  } finally { await ui.stop(); }
});

test("window file navigation listeners are scoped to the mounted image composer", async () => {
  const ui = await images();
  const target = window;
  function event(type: string, dataTransfer?: unknown) {
    return Object.assign(new Event(type, { cancelable: true }), { dataTransfer });
  }
  try {
    for (const data of [undefined, transfer().dataTransfer]) {
      const empty = event("dragover", data);
      target.dispatchEvent(empty);
      expect(empty.defaultPrevented).toBe(false);
    }
    const files = event("drop", transfer([], [], ["Files"]).dataTransfer);
    target.dispatchEvent(files);
    expect(files.defaultPrevented).toBe(true);
    expect(location.href).toBe("http://example.invalid/");
  } finally { await ui.stop(); }
  const after = event("drop", transfer([image()]).dataTransfer);
  target.dispatchEvent(after);
  expect(after.defaultPrevented).toBe(false);
});

test("image tray explains failed negotiation and loading without requiring a retry callback", () => {
  const props = { attachments: [], enabled: false, error: "", onAdd() {}, onRemove() {} };
  expect(renderToStaticMarkup(<ImageAttachmentTray {...props} />)).toBe("");
  expect(renderToStaticMarkup(<ImageAttachmentTray {...props} loading />)).toContain("Loading image…");
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  try {
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { language: undefined } });
    const failed = renderToStaticMarkup(<ImageAttachmentTray {...props} capability="unknown" capabilityError="Synthetic failure" />);
    expect(failed).toContain("Could not check image support. Synthetic failure");
    expect(failed).not.toContain(">Retry<");
    Reflect.deleteProperty(globalThis, "navigator");
    expect(renderToStaticMarkup(<ImageAttachmentTray {...props} capability="unsupported" />)).toContain("You can still send text.");
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "navigator", descriptor);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
});
