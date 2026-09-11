import { expect, test } from "bun:test";
import { act, createElement } from "react";
import type { SessionState } from "../src/session";
import { clientFixture } from "./client-fixture";

test("a cold token-prefixed session route subscribes to the exact session and never adopts a newer Boss", async () => {
  const nativeSocket = globalThis.WebSocket;
  const nativeFetch = globalThis.fetch;
  const sockets: any[] = [];
  class RouteSocket {
    static OPEN = 1;
    readyState = 0;
    sent: any[] = [];
    onopen?: (event: Event) => void;
    onclose?: (event: Event) => void;
    onmessage?: (event: { data: string }) => void;
    constructor(address: string) {
      expect(address).toBe("wss://example.invalid/token/ws");
      sockets.push(this);
    }
    send(data: string) { this.sent.push(JSON.parse(data)); }
    close() { this.readyState = 3; this.onclose?.(new Event("close")); }
  }
  globalThis.WebSocket = RouteSocket as any;
  globalThis.fetch = (() => { throw new Error("Routed client must not fetch"); }) as any;
  const client = await clientFixture("https://example.invalid/token/s/pinned");
  let state: SessionState;
  try {
    window.__AGENT_CHAT_BASE__ = "/token";
    // The route is captured at module load, as it is when a browser opens this page.
    const { useSession } = await import("../src/session");
    function Probe() { state = useSession(); return null; }
    await client.render(createElement(Probe));
    expect(state.phase).toBe("chat");
    const socket = sockets[0];
    await act(async () => { socket.readyState = 1; socket.onopen(new Event("open")); });
    expect(socket.sent).toEqual([{ op: "subscribe", sessionId: "pinned" }, { op: "warm-boss" }]);
    const receive = (message: unknown) => act(async () => socket.onmessage({ data: JSON.stringify(message) }));
    await receive({
      kind: "hello", providers: [], defaultCwd: "/work",
      experience: {
        productName: "Workbench", surfaceName: "Boss", defaultProvider: "demo",
        localAuthorityLabel: "Local", externalAuthority: { label: "External", status: "unknown" },
      },
      boss: { status: "canonical", agent: "demo", sessionId: "newer", skipped: [] },
    });
    await receive({ kind: "sessions", sessions: [{ id: "newer", title: "Newer", provider: "demo", cwd: "/work", status: "idle" }] });
    expect(location.pathname).toBe("/token/s/pinned");
    expect(socket.sent.filter((message: any) => message.op === "subscribe")).toEqual([{ op: "subscribe", sessionId: "pinned" }]);
    let pending: Promise<boolean>;
    act(() => { pending = state.reply("Reply while history is loading"); });
    expect(state.session).toBeNull();
    const sent = socket.sent.at(-1);
    expect(sent).toMatchObject({ op: "send", sessionId: "pinned", prompt: "Reply while history is loading" });
    await receive({ kind: "send-accepted", requestId: sent.requestId });
    expect(await pending).toBe(true);
    await receive({ kind: "history", session: { id: "pinned", title: "Existing Boss", provider: "demo", cwd: "/work", status: "idle" }, events: [] });
    expect(state.session.id).toBe("pinned");
    await receive({ kind: "hello", providers: [], defaultCwd: "/work" });
    act(() => state.compose());
    expect(location.pathname).toBe("/token/");
    act(() => state.start({ provider: "demo", cwd: "/work", prompt: "Retire this" }));
    const start = socket.sent.at(-1);
    await receive({ kind: "error", op: "start", requestId: start.requestId, message: "Failed" });
    await receive({ kind: "history", session: { id: "pinned", title: "Existing Boss", provider: "demo", cwd: "/work", status: "idle" }, events: [] });
    await receive({ kind: "session-created", requestId: start.requestId, session: { id: "retired" } });
    expect(socket.sent.slice(-2)).toEqual([
      { op: "cancel-start", requestId: start.requestId, retire: true },
      { op: "subscribe", sessionId: "pinned" },
    ]);
    expect(state.session.id).toBe("pinned");
    window.__AGENT_CHAT_BASE__ = "/";
    await receive({ kind: "no-session" });
    await receive({ kind: "session-status", sessionId: null, status: "running" });
    expect(state.session).toBeNull();
    expect(location.pathname).toBe("/");
    window.__AGENT_CHAT_BASE__ = undefined;
    act(() => state.compose());
    expect(location.pathname).toBe("/");
  } finally {
    await client.stop();
    globalThis.WebSocket = nativeSocket;
    globalThis.fetch = nativeFetch;
  }
  expect(sockets.every((socket) => socket.readyState === 3)).toBe(true);
});
