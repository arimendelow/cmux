#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

// Both native CLI and ACP traffic terminate at the test-owned controller.
const controller = process.env.RECOVERY_TEST_URL!;
const rpc = Bun.argv.indexOf("rpc");
const role = rpc >= 0 ? "rpc" : Bun.argv.includes("events") ? "events" : "acp";
if (process.env.RECOVERY_TEST_PROCESS_LOG) {
  appendFileSync(process.env.RECOVERY_TEST_PROCESS_LOG, `${JSON.stringify({ pid: process.pid, ppid: process.ppid, role })}\n`);
}
const lifetime = process.env.RECOVERY_TEST_PEER_LIFETIME;
if (role === "acp" && (lifetime === "until-sigterm" || lifetime === "until-sigkill")) {
  if (lifetime === "until-sigkill") process.on("SIGTERM", () => {});
  process.stdout.on("error", () => {});
  process.on("unhandledRejection", () => {});
  setInterval(() => {}, 60_000);
}
if (rpc >= 0) {
  const response = await fetch(`${controller}/native`, {
    method: "POST",
    body: JSON.stringify({
      method: Bun.argv[rpc + 1],
      params: JSON.parse(Bun.argv[rpc + 2]!),
    }),
  });
  if (!response.ok) process.exit(1);
  process.stdout.write(await response.text());
} else if (Bun.argv.includes("events")) {
  const response = await fetch(`${controller}/events`, {
    method: "POST",
    body: JSON.stringify(Bun.argv.slice(2)),
  });
  for await (const chunk of response.body!) process.stdout.write(chunk);
} else {
  const reader = createInterface({ input: process.stdin });
  for await (const line of reader) {
    if (!line.trim()) continue;
    // A pending prompt must not prevent the peer from reading session/cancel.
    void fetch(`${controller}/acp`, { method: "POST", body: line }).then(async (response) => {
      const holdInput = process.env.RECOVERY_TEST_HOLD_PROMPT_INPUT === "1"
        && JSON.parse(line).method === "session/new";
      if (holdInput) process.stdin.once("data", (chunk) => {
        reader.pause();
        void fetch(`${controller}/acp`, {
          method: "POST",
          body: JSON.stringify({ method: "test/prompt-input", params: { prefix: chunk.toString().slice(0, 128) } }),
        }).then(() => reader.resume());
      });
      for (const message of await response.json() as unknown[]) {
        process.stdout.write(`${JSON.stringify(message)}\n`);
      }
    });
  }
}
