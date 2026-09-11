import { test } from "bun:test";
import { checkInitialSessionRoute } from "./initial-session-route";

test("a session pathname outside the injected base is preserved rather than incorrectly sliced", async () => {
  await checkInitialSessionRoute({
    url: "https://example.invalid/s/outside",
    base: "/token",
    websocket: "wss://example.invalid/token/ws",
    sessionId: "outside",
    composerPath: "/token/",
  });
});
