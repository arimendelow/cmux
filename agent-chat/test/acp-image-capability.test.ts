import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  imageCapabilityFromInitializeForTest,
  imageCapabilityOfForTest,
  resetImageCapabilityForTest,
} from "../adapters/acp";

const scratchRoot = join(import.meta.dir, ".scratch");

async function tempRoot(prefix: string): Promise<string> {
  await mkdir(scratchRoot, { recursive: true });
  return mkdtemp(join(scratchRoot, prefix));
}

async function waitForPort(stateFile: string): Promise<number> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const state = JSON.parse(await readFile(stateFile, "utf8"));
      if (Number.isInteger(state.port) && state.port > 0) return state.port;
    } catch {}
    await Bun.sleep(20);
  }
  throw new Error("timed out waiting for Agent Chat state file");
}

test("image prompt capability is a three-state value derived from the initialize result", () => {
  expect(imageCapabilityFromInitializeForTest(undefined)).toBe("unsupported");
  expect(imageCapabilityFromInitializeForTest({})).toBe("unsupported");
  expect(imageCapabilityFromInitializeForTest({ agentCapabilities: {} })).toBe("unsupported");
  expect(imageCapabilityFromInitializeForTest({
    agentCapabilities: { promptCapabilities: {} },
  })).toBe("unsupported");
  expect(imageCapabilityFromInitializeForTest({
    agentCapabilities: { promptCapabilities: { image: false } },
  })).toBe("unsupported");
  expect(imageCapabilityFromInitializeForTest({
    agentCapabilities: { promptCapabilities: { image: true } },
  })).toBe("supported");
  expect(imageCapabilityFromInitializeForTest({
    agentCapabilities: { promptCapabilities: { image: "yes" } },
  })).toBe("unsupported");
}, 60_000);

test("a session with no live ACP connection reports unknown image capability", () => {
  const sess = { internal: {} as Record<string, unknown> };
  expect(imageCapabilityOfForTest(sess)).toBe("unknown");
  sess.internal.acp = { imageCapability: "supported" };
  expect(imageCapabilityOfForTest(sess)).toBe("supported");
  resetImageCapabilityForTest(sess);
  expect(imageCapabilityOfForTest(sess)).toBe("unknown");
});

async function startBossServer(
  root: string,
  imageFlag: string[],
  methodLog = "",
): Promise<{ port: number; stop(): Promise<void> }> {
  const stateFile = join(root, "server.json");
  const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  const ouro = join(bin, "ouro");
  await Bun.write(
    ouro,
    `#!/bin/sh\nexec "$BUN_BIN" "$FAKE_ACP_SCRIPT" ${imageFlag.join(" ")} "$@"\n`,
  );
  await chmod(ouro, 0o755);
  const child = Bun.spawn(["bun", "server.ts"], {
    cwd: join(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...globalThis.process.env,
      PATH: `${bin}:${globalThis.process.env.PATH ?? ""}`,
      BUN_BIN: Bun.which("bun") ?? "bun",
      FAKE_ACP_SCRIPT: join(import.meta.dir, "fake-acp.ts"),
      ...(methodLog ? { FAKE_ACP_METHOD_LOG: methodLog } : {}),
      CMUX_AGENT_CHAT_PORT: "0",
      CMUX_AGENT_CHAT_STATE_FILE: stateFile,
      CMUX_AGENT_CHAT_TOKEN: "capability-token",
      CMUX_AGENT_CHAT_PRODUCT: "ouro-workbench-v1",
      CMUX_AGENT_CHAT_BOSS_AGENT: "slugger",
      CMUX_AGENT_CHAT_SESSION_DIR: join(root, "sessions", "slugger"),
      CMUX_AGENT_CHAT_ALLOWED_ROOTS: root,
      CMUX_AGENT_UI_CWD: join(root, "work"),
      CMUX_AGENT_MODELS_URL: "http://127.0.0.1:1",
    },
  });
  const port = await waitForPort(stateFile);
  return {
    port,
    async stop() {
      child.kill();
      await child.exited;
    },
  };
}

async function capabilityAfterStart(imageFlag: string[]): Promise<string> {
  const root = await tempRoot("capability-");
  const work = join(root, "work");
  await mkdir(work, { recursive: true });
  const server = await startBossServer(root, imageFlag);
  try {
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/capability-token/ws`);
    const messages: any[] = [];
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error("WebSocket failed to open"));
    });
    socket.onmessage = (event) => messages.push(JSON.parse(String(event.data)));
    socket.send(JSON.stringify({
      op: "start",
      requestId: "capability",
      provider: "ouro-boss",
      cwd: work,
      prompt: "hello",
    }));
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const event = messages.find((message) =>
        message.kind === "event" && message.evt?.kind === "capabilities");
      if (event) {
        socket.close();
        return String(event.evt.image);
      }
      await Bun.sleep(20);
    }
    socket.close();
    throw new Error(`no capabilities event: ${JSON.stringify(messages).slice(0, 400)}`);
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
}

test("a peer that advertises image prompt capability reaches the client as supported", async () => {
  expect(await capabilityAfterStart(["--image-capability", "supported"])).toBe("supported");
}, 60_000);

test("a peer without image prompt capability reaches the client as unsupported", async () => {
  expect(await capabilityAfterStart([])).toBe("unsupported");
}, 60_000);

test("the canonical Boss negotiates capability before the first user turn", async () => {
  const root = await tempRoot("capability-eager-");
  const work = join(root, "work");
  await mkdir(work, { recursive: true });
  const partition = join(root, "sessions", "slugger");
  await mkdir(partition, { recursive: true });
  await Bun.write(join(partition, "boss-1.json"), JSON.stringify({
    id: "boss-1",
    provider: "ouro-boss",
    providerSessionId: "boss-1",
    cwd: work,
    title: "Boss",
    autoApprove: false,
    startOptions: {},
    createdAt: 10,
  }));
  const methodLog = join(root, "methods.log");
  const server = await startBossServer(root, ["--image-capability", "supported"], methodLog);
  try {
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/capability-token/ws`);
    const messages: any[] = [];
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error("WebSocket failed to open"));
    });
    socket.onmessage = (event) => messages.push(JSON.parse(String(event.data)));
    socket.send(JSON.stringify({ op: "warm-boss" }));
    const deadline = Date.now() + 15_000;
    let capability: any;
    while (Date.now() < deadline && !capability) {
      capability = messages.find((message) =>
        message.kind === "event" && message.evt?.kind === "capabilities");
      await Bun.sleep(20);
    }
    expect(capability?.evt?.image).toBe("supported");
    // Negotiation only: the peer saw initialize and a session load, never a
    // prompt, so no user turn was spent to learn its capabilities.
    const methods = (await readFile(methodLog, "utf8")).split("\n").filter(Boolean);
    expect(methods).toContain("initialize");
    expect(methods).not.toContain("session/prompt");
    socket.close();
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
