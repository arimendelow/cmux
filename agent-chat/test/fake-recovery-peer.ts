#!/usr/bin/env bun
import { createInterface } from "node:readline";

// Both native CLI and ACP traffic terminate at the test-owned controller.
const controller = process.env.RECOVERY_TEST_URL!;
const rpc = Bun.argv.indexOf("rpc");
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
  for await (const line of createInterface({ input: process.stdin })) {
    if (!line.trim()) continue;
    // A pending prompt must not prevent the peer from reading session/cancel.
    void fetch(`${controller}/acp`, { method: "POST", body: line }).then(async (response) => {
      for (const message of await response.json() as unknown[]) {
        process.stdout.write(`${JSON.stringify(message)}\n`);
      }
    });
  }
}
