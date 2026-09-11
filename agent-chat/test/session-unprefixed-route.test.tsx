import { test } from "bun:test";
import { checkInitialSessionRoute } from "./initial-session-route";

test("an unprefixed cold session route subscribes without requiring injected base configuration", async () => {
  await checkInitialSessionRoute({
    url: "http://example.invalid/s/plain",
    websocket: "ws://example.invalid/ws",
    sessionId: "plain",
    composerPath: "/",
  });
});
