import { test } from "bun:test";
import { checkInitialSessionRoute } from "./initial-session-route";

test("a bare token URL is the composer root and normalizes a trailing base slash", async () => {
  await checkInitialSessionRoute({
    url: "https://example.invalid/token",
    base: "/token/",
    websocket: "wss://example.invalid/token/ws",
    sessionId: null,
    composerPath: "/token/",
  });
});
