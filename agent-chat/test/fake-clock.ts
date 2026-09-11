import { createInterface } from "node:readline";

// Preloaded only by the test-owned sidecar; protocol and cancellation timers stay real.
let now = Date.now();
Date.now = () => now;
createInterface({ input: process.stdin }).on("line", (line) => {
  const value = Number(line);
  if (!Number.isFinite(value)) throw new Error("invalid test clock");
  now = value;
  console.log(`test-clock:${now}`);
});
