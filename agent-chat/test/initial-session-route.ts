import { expect } from "bun:test";
import { act, createElement } from "react";
import type { SessionState } from "../src/session";
import { clientFixture } from "./client-fixture";

// Each caller is a separate explicit test root because session routing is captured at module load.
export async function checkInitialSessionRoute(input: {
  url: string;
  base?: string;
  websocket: string;
  sessionId: string | null;
  composerPath: string;
}) {
  const nativeSocket = globalThis.WebSocket;
  const nativeFetch = globalThis.fetch;
  const sent: unknown[] = [];
  let socket: RouteSocket;
  class RouteSocket {
    static OPEN = 1;
    readyState = 0;
    onopen?: (event: Event) => void;
    onclose?: (event: Event) => void;
    onmessage?: (event: { data: string }) => void;
    constructor(address: string) { expect(address).toBe(input.websocket); socket = this; }
    send(data: string) { expect(this.readyState).toBe(1); sent.push(JSON.parse(data)); }
    close() { this.readyState = 3; this.onclose?.(new Event("close")); }
  }
  globalThis.WebSocket = RouteSocket as any;
  globalThis.fetch = (() => { throw new Error("Initial route must not fetch"); }) as any;
  const client = await clientFixture(input.url);
  let state: SessionState;
  try {
    window.__AGENT_CHAT_BASE__ = input.base;
    const { useSession } = await import("../src/session");
    function Probe() { state = useSession(); return null; }
    await client.render(createElement(Probe));
    expect(state.phase).toBe(input.sessionId ? "chat" : "composer");
    expect(state.session).toBeNull();
    await act(async () => { socket.readyState = 1; socket.onopen?.(new Event("open")); });
    expect(sent).toEqual(input.sessionId ? [{ op: "subscribe", sessionId: input.sessionId }, { op: "warm-boss" }] : []);
    expect(location.href).toBe(new URL(input.url).href);
    act(() => state.compose());
    expect(state.phase).toBe("composer");
    expect(state.session).toBeNull();
    expect(location.pathname).toBe(input.composerPath);
  } finally {
    await client.stop();
    globalThis.WebSocket = nativeSocket;
    globalThis.fetch = nativeFetch;
  }
  expect(socket.readyState).toBe(3);
}
