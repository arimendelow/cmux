import { createInterface } from "node:readline";

// Preloaded only by the test-owned sidecar; timers run normally unless explicitly expired.
let now = Date.now();
Date.now = () => now;
const setTimer = globalThis.setTimeout;
const clearTimer = globalThis.clearTimeout;
const startups = new Map<ReturnType<typeof setTimeout>, () => void>();
globalThis.setTimeout = ((callback: (...args: any[]) => void, delay?: number, ...args: any[]) => {
  const timer = setTimer(callback, delay, ...args);
  if (delay === 90_000) startups.set(timer, () => callback(...args));
  return timer;
}) as typeof setTimeout;
globalThis.clearTimeout = (timer) => {
  startups.delete(timer as ReturnType<typeof setTimeout>);
  clearTimer(timer);
};
createInterface({ input: process.stdin }).on("line", (line) => {
  if (line === "startup-timeout") {
    if (startups.size !== 1) throw new Error("expected exactly one ACP startup timer");
    for (const [timer, expire] of startups) {
      clearTimeout(timer);
      expire();
    }
    console.log("test-startup-timeout");
    return;
  }
  const value = Number(line);
  if (!Number.isFinite(value)) throw new Error("invalid test clock");
  now = value;
  console.log(`test-clock:${now}`);
});
