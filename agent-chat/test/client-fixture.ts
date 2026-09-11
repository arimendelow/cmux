import { act, type ReactNode } from "react";

/** Run real React effects and client callbacks without a browser, profile, or DOM renderer. */
export async function clientFixture(
  url: string,
  intercept?: (message: any, deliver: () => void, connection: number) => boolean,
  locale = "en",
  onSend?: (message: any, connection: number) => void,
) {
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (name: string, value: unknown) => {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  const storage = () => {
    const values = new Map<string, string>();
    return {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, String(value)); },
      removeItem: (key: string) => { values.delete(key); },
    };
  };
  const timers = new Map<number, () => void>();
  let timerId = 0;
  const document = Object.assign(new EventTarget(), {
    nodeType: 9, activeElement: null, title: "",
    documentElement: { style: { setProperty() {} }, dataset: {} },
  });
  const location = new URL(url);
  const window = Object.assign(new EventTarget(), {
    document,
    location,
    HTMLIFrameElement: class {},
    __AGENT_CHAT_BASE__: location.pathname.replace(/\/$/, ""),
    setTimeout: (callback: () => void) => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: (id: number) => { timers.delete(id); },
  });
  Object.assign(document, { defaultView: window });
  const NativeWebSocket = globalThis.WebSocket;
  let connectionSequence = 0;
  class ClientSocket {
    static OPEN = NativeWebSocket.OPEN;
    private connection = ++connectionSequence;
    private socket: WebSocket;
    onopen?: (event: Event) => void;
    onclose?: (event: CloseEvent) => void;
    onerror?: (event: Event) => void;
    onmessage?: (event: MessageEvent) => void;
    constructor(address: string) {
      this.socket = new NativeWebSocket(address);
      this.socket.onopen = (event) => { act(() => this.onopen?.(event)); };
      this.socket.onclose = (event) => { act(() => this.onclose?.(event)); };
      this.socket.onerror = (event) => { act(() => this.onerror?.(event)); };
      this.socket.onmessage = (event) => {
        const deliver = () => { act(() => this.onmessage?.(event)); };
        if (!intercept?.(JSON.parse(String(event.data)), deliver, this.connection)) deliver();
      };
    }
    get readyState() { return this.socket.readyState; }
    send(data: string) { onSend?.(JSON.parse(data), this.connection); this.socket.send(data); }
    close() { this.socket.close(); }
  }
  install("document", document);
  install("getComputedStyle", () => ({ getPropertyValue: () => "#111111" }));
  install("window", window);
  install("location", location);
  install("navigator", { language: locale });
  install("history", {
    replaceState: (_state: unknown, _title: string, path: string) => {
      location.href = new URL(path, location).href;
    },
  });
  install("localStorage", storage());
  install("sessionStorage", storage());
  install("WebSocket", ClientSocket);
  install("IS_REACT_ACT_ENVIRONMENT", true);
  const { createRoot } = await import("react-dom/client");
  const container = Object.assign(new EventTarget(), {
    nodeType: 1, tagName: "DIV", nodeName: "DIV", ownerDocument: document,
  });
  const root = createRoot(container as unknown as Element);
  return {
    async render(node: ReactNode) { await act(async () => root.render(node)); },
    async expireStartTimeout() {
      await act(async () => {
        for (const callback of [...timers.values()]) callback();
      });
    },
    async stop() {
      await act(async () => root.unmount());
      for (const [name, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete (globalThis as any)[name];
      }
    },
  };
}
