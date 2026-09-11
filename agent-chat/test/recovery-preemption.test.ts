import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readLines } from "../adapters/lines";
import { act, createElement } from "react";
import { useSession, type SessionState } from "../src/session";
import { clientFixture } from "./client-fixture";

const appId = "11111111-1111-4111-8111-111111111111";
const bossId = "boss-1";
const peerSessionId = "peer-boss-1";

function snapshot(state = "running", restoreState = "ready", revision = 10) {
  return {
    topology: {
      app_instance_id: appId,
      app_started_at: "2026-01-01T00:00:00Z",
      previous_exit_clean: true,
      restore_state: restoreState,
      revision,
      windows: [{
        window_id: "22222222-2222-4222-8222-222222222222",
        workspaces: [{
          workspace_id: "33333333-3333-4333-8333-333333333333",
          panes: [{
            pane_id: "44444444-4444-4444-8444-444444444444",
            surfaces: [{
              surface_id: "55555555-5555-4555-8555-555555555555",
              type: "terminal",
              title: "Example worker",
              resume: {
                state,
                session_id: "worker-1",
                binding_present: true,
                workbench_authority: state === "blocked_unverified" ? "unknown" : "local",
                blocked_reason: state === "blocked_unverified" ? "authority_unverified" : null,
              },
            }],
          }],
        }],
      }],
    },
    changes: {
      after_sequence: 0,
      latest_sequence: revision,
      events: [{
        type: "event",
        name: "app.restore.completed",
        seq: revision,
        payload: { mode: "startup", restored: true, window_count: 1 },
      }],
    },
    sessions: [],
  };
}

// Event-driven barriers, not elapsed sleeps or polling.
class Inbox<T> {
  all: T[] = [];
  private waiters: Array<{ matches: (value: T) => boolean; resolve: (value: T) => void }> = [];

  push(value: T) {
    this.all.push(value);
    for (const waiter of [...this.waiters]) {
      if (!waiter.matches(value)) continue;
      this.waiters.splice(this.waiters.indexOf(waiter), 1);
      waiter.resolve(value);
    }
  }

  next(matches: (value: T) => boolean): Promise<T> {
    const existing = this.all.find(matches);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("expected recovery event was not delivered")), 3_000);
      this.waiters.push({
        matches,
        resolve: (value) => { clearTimeout(timer); resolve(value); },
      });
    });
  }
}

interface PeerRequest {
  message: any;
  finish(result?: unknown, error?: string): void;
}

async function harness(options: {
  facts?: ReturnType<typeof snapshot>;
  holdNative?: boolean;
  holdInitialize?: boolean;
  nativeFailure?: boolean;
  loadFailure?: boolean;
  warm?: boolean;
  fresh?: boolean;
  imageSupport?: boolean;
  startRequestId?: string;
} = {}) {
  const scratch = join(import.meta.dir, "../scratch");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "recovery-"));
  const partition = join(root, "sessions", "example-boss");
  await mkdir(partition, { recursive: true });
  if (!options.fresh) await writeFile(join(partition, `${bossId}.json`), JSON.stringify({
    id: bossId,
    provider: "ouro-boss",
    providerSessionId: peerSessionId,
    cwd: root,
    title: "Boss",
    autoApprove: false,
    startOptions: {},
    createdAt: 1,
    ...(options.startRequestId ? { startRequestId: options.startRequestId } : {}),
  }));
  const peers = new Inbox<PeerRequest>();
  const native = new Inbox<any>();
  const initialized = Promise.withResolvers<void>();
  const nativeReady = Promise.withResolvers<void>();
  if (!options.holdInitialize) initialized.resolve();
  if (!options.holdNative) nativeReady.resolve();
  let facts = options.facts ?? snapshot("blocked_unverified");
  let stream: ReadableStreamDefaultController<string> | undefined;
  const control = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/native") {
        native.push(await request.json());
        await nativeReady.promise;
        return options.nativeFailure
          ? new Response("native unavailable", { status: 503 })
          : Response.json(facts);
      }
      if (path === "/events") {
        native.push({ stream: await request.json() });
        return new Response(new ReadableStream<string>({
          start(controller) {
            stream = controller;
            controller.enqueue(`${JSON.stringify({ type: "ack", resume: { latest_seq: 10, gap: false } })}\n`);
          },
          cancel() { stream = undefined; },
        }));
      }
      const message = await request.json() as any;
      const response = Promise.withResolvers<Response>();
      const entry: PeerRequest = {
        message,
        finish(result = { stopReason: "end_turn" }, error) {
          response.resolve(Response.json(message.id === undefined ? [] : [{
            jsonrpc: "2.0",
            id: message.id,
            ...(error ? { error: { code: -32000, message: error } } : { result }),
          }]));
        },
      };
      peers.push(entry);
      if (message.method === "initialize") {
        await initialized.promise;
        entry.finish({ protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: options.imageSupport !== false } } });
      } else if (message.method === "session/new") {
        entry.finish({ sessionId: message.params.sessionId });
      } else if (message.method === "session/load") {
        entry.finish({}, options.loadFailure ? "synthetic saved-session failure" : undefined);
      } else if (message.method !== "session/prompt") {
        entry.finish({});
      }
      return response.promise;
    },
  });
  const address = Promise.withResolvers<string>();
  const peer = join(import.meta.dir, "fake-recovery-peer.ts");
  const child = Bun.spawn([process.execPath, "server.ts"], {
    cwd: join(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env.PATH,
      HOME: root,
      RECOVERY_TEST_URL: `http://127.0.0.1:${control.port}`,
      CMUX_AGENT_CHAT_OURO_COMMAND: peer,
      CMUX_BUNDLED_CLI_PATH: peer,
      CMUX_SOCKET_PATH: join(root, "native.sock"),
      CMUX_SOCKET_CAPABILITY: "synthetic-capability",
      CMUX_AGENT_CHAT_PORT: "0",
      CMUX_AGENT_CHAT_TOKEN: "test-token",
      CMUX_AGENT_CHAT_PRODUCT: "ouro-workbench-v1",
      CMUX_AGENT_CHAT_BOSS_AGENT: "example-boss",
      CMUX_AGENT_CHAT_SESSION_DIR: partition,
      CMUX_AGENT_CHAT_ALLOWED_ROOTS: root,
      CMUX_AGENT_UI_CWD: root,
      CMUX_AGENT_MODELS_URL: "http://127.0.0.1:1",
      CMUX_WORKBENCH_APP_INSTANCE_ID: appId,
      CMUX_WORKBENCH_APP_STARTED_AT: "2026-01-01T00:00:00Z",
      CMUX_WORKBENCH_PREVIOUS_EXIT_CLEAN: "1",
    },
  });
  const errors: string[] = [];
  void readLines(child.stderr, (line) => errors.push(line));
  void readLines(child.stdout, (line) => {
    const url = line.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
    if (url) address.resolve(`${url}/test-token`);
  }, () => address.reject(new Error(errors.join("\n"))));
  const url = await address.promise;
  const messages = new Inbox<any>();
  const socket = new WebSocket(`${url.replace("http:", "ws:")}/ws`);
  socket.onmessage = (event) => messages.push(JSON.parse(String(event.data)));
  await messages.next((message) => message.kind === "hello");
  const send = (message: unknown) => socket.send(JSON.stringify(message));
  if (!options.fresh) {
    send({ op: "subscribe", sessionId: bossId });
    if (options.warm !== false) send({ op: "warm-boss" });
  }
  return {
    url,
    root,
    peers,
    native,
    messages,
    send,
    releaseInitialize: initialized.resolve,
    releaseNative: nativeReady.resolve,
    setFacts(value: ReturnType<typeof snapshot>) { facts = value; },
    publish(event: unknown) { stream?.enqueue(`${JSON.stringify(event)}\n`); },
    receipt(assessment: string) {
      return messages.next((message) =>
        message.kind === "event"
        && message.evt?.kind === "workbench-restore"
        && message.evt.assessment === assessment).then((message) => message.evt);
    },
    prompt(index = 0) {
      return peers.next((entry) =>
        entry.message.method === "session/prompt"
        && peers.all.filter((item) => item.message.method === "session/prompt").indexOf(entry) === index);
    },
    async barrier() {
      send({ op: "check-cwd", cwd: root });
      await messages.next((message) => message.kind === "cwd-check");
    },
    async boss() { return (await fetch(`${url}/api/boss`)).json() as Promise<any>; },
    async stop() {
      initialized.resolve();
      nativeReady.resolve();
      for (const entry of peers.all) entry.finish({ stopReason: "cancelled" });
      socket.close();
      child.kill();
      await child.exited;
      control.stop(true);
      await rm(root, { recursive: true, force: true });
    },
    async assertSameBoss(id = bossId, providerSession = peerSessionId) {
      const pointer = JSON.parse(await readFile(join(root, "sessions/canonical-boss.json"), "utf8"));
      expect(pointer).toEqual({ version: 1, agent: "example-boss", sessionId: id });
      expect(peers.all.filter((entry) => entry.message.method === "session/new")).toHaveLength(options.fresh ? 1 : 0);
      expect(peers.all.filter((entry) => entry.message.method === "session/load")
        .every((entry) => entry.message.params.sessionId === providerSession)).toBe(true);
    },
  };
}

test("clean native restore emits a factual receipt without a speculative model turn", async () => {
  const facts = snapshot();
  facts.topology.previous_exit_clean = false; // A recovered unclean exit alone is not an exception.
  const h = await harness({ facts });
  try {
    const receipt = await h.receipt("none");
    expect(receipt.facts).toEqual(facts);
    expect(receipt.unresolved).toEqual([]);
    h.send({ op: "warm-boss" });
    h.send({ op: "warm-boss" });
    await h.barrier();
    expect(h.peers.all.some((entry) => entry.message.method === "session/prompt")).toBe(false);
    expect((await h.boss()).restore.facts).toEqual(facts);
    await h.assertSameBoss();
  } finally { await h.stop(); }
});

test("visible draft input cancels pending assessment and preserves facts for an image-only turn", async () => {
  const h = await harness({ holdInitialize: true });
  try {
    await h.receipt("pending");
    h.send({ op: "user-input" });
    const cancelled = await h.receipt("cancelled");
    expect(cancelled.unresolved[0].reason).toBe("authority_unverified");
    h.releaseInitialize();
    h.send({
      op: "send",
      requestId: "image-input",
      sessionId: bossId,
      prompt: "",
      attachments: [{ id: "image-1", name: "example.png", mimeType: "image/png", data: "cG5n" }],
    });
    const user = await h.prompt();
    expect(user.message.params.sessionId).toBe(peerSessionId);
    expect(user.message.params.prompt[0]).toEqual({ type: "image", mimeType: "image/png", data: "cG5n" });
    expect(JSON.stringify(user.message.params.prompt)).toContain("authority_unverified");
    user.finish();
    expect(h.peers.all.filter((entry) => entry.message.method === "session/prompt")).toHaveLength(1);
    expect((await h.boss()).restore.facts).toEqual(snapshot("blocked_unverified"));
    await h.assertSameBoss();
  } finally { await h.stop(); }
});

test("running assessment cancellation settles before real Send enters the same Boss turn stream", async () => {
  const h = await harness();
  try {
    const assessment = await h.prompt();
    expect(JSON.stringify(assessment.message.params.prompt)).toContain("authority_unverified");
    h.send({ op: "user-input" });
    h.send({ op: "user-input" });
    h.send({ op: "send", sessionId: bossId, requestId: "user-wins", prompt: "Use my instructions instead." });
    await h.peers.next((entry) => entry.message.method === "session/cancel");
    await h.barrier();
    expect(h.peers.all.filter((entry) => entry.message.method === "session/prompt")).toHaveLength(1);
    expect(h.messages.all.some((message) => message.kind === "send-accepted")).toBe(false);
    expect(h.peers.all.filter((entry) => entry.message.method === "session/cancel")).toHaveLength(1);
    assessment.finish({ stopReason: "cancelled" });
    const user = await h.prompt(1);
    expect(JSON.stringify(user.message.params.prompt)).toContain("Use my instructions instead.");
    expect(JSON.stringify(user.message.params.prompt)).toContain("authority_unverified");
    user.finish();
    await h.messages.next((message) => message.kind === "send-accepted" && message.requestId === "user-wins");
    expect((await h.boss()).restore.assessment).toBe("cancelled");
    await h.assertSameBoss();
  } finally { await h.stop(); }
});

test("automatic assessment is not echoed as user input and Stop still controls the subsequent user turn", async () => {
  const h = await harness();
  try {
    const assessment = await h.prompt();
    h.send({ op: "user-input" });
    await h.receipt("cancelling");
    await h.peers.next((entry) => entry.message.method === "session/cancel");
    assessment.finish({ stopReason: "cancelled" });
    await h.receipt("cancelled");
    expect(h.messages.all.some((message) => message.evt?.kind === "user")).toBe(false);
    h.send({ op: "send", sessionId: bossId, requestId: "subsequent-user", prompt: "Follow my request." });
    const user = await h.prompt(1);
    h.send({ op: "stop", sessionId: bossId });
    await h.peers.next((entry) =>
      entry.message.method === "session/cancel"
      && h.peers.all.filter((item) => item.message.method === "session/cancel").indexOf(entry) === 1);
    user.finish({ stopReason: "cancelled" });
    await h.assertSameBoss();
  } finally { await h.stop(); }
});

test("a busy user turn preempts recovery even when native facts arrive later", async () => {
  const h = await harness({ holdNative: true });
  try {
    h.send({ op: "send", sessionId: bossId, requestId: "busy", prompt: "Keep working on my request." });
    const user = await h.prompt();
    h.releaseNative();
    const receipt = await h.receipt("cancelled");
    expect(receipt.facts).toEqual(snapshot("blocked_unverified"));
    user.finish();
    await h.messages.next((message) => message.kind === "session-status" && message.status === "idle");
    h.send({ op: "warm-boss" });
    await h.barrier();
    expect(h.peers.all.filter((entry) => entry.message.method === "session/prompt")).toHaveLength(1);
    expect(h.peers.all.some((entry) => entry.message.method === "session/cancel")).toBe(false);
  } finally { await h.stop(); }
});

test("native completion notifications are event-driven and duplicate delivery assesses only once", async () => {
  const h = await harness({ facts: snapshot("resuming", "restoring") });
  try {
    await h.receipt("waiting");
    await h.native.next((request) => Array.isArray(request.stream));
    expect(h.peers.all.some((entry) => entry.message.method === "session/prompt")).toBe(false);
    h.setFacts(snapshot("manual_resume_available", "ready", 11));
    const event = { type: "event", name: "app.restore.completed", category: "app", seq: 11 };
    h.publish(event);
    h.publish(event);
    const assessment = await h.prompt();
    assessment.finish();
    await h.receipt("completed");
    h.send({ op: "warm-boss" });
    h.send({ op: "subscribe", sessionId: bossId });
    await h.barrier();
    expect(h.peers.all.filter((entry) => entry.message.method === "session/prompt")).toHaveLength(1);
    expect(h.native.all.filter((request) => request.method).every((request) => request.method === "workbench.list")).toBe(true);
    await h.assertSameBoss();
  } finally { await h.stop(); }
});

test("failed assessment is visible, never retried automatically, and keeps native facts", async () => {
  const h = await harness();
  try {
    const assessment = await h.prompt();
    assessment.finish(undefined, "synthetic assessment failure");
    const receipt = await h.receipt("failed");
    expect(receipt.facts).toEqual(snapshot("blocked_unverified"));
    h.send({ op: "send", sessionId: bossId, requestId: "after-failure", prompt: "Explain the restore facts." });
    const user = await h.prompt(1);
    expect(JSON.stringify(user.message.params.prompt)).toContain("authority_unverified");
    user.finish();
    await h.assertSameBoss();
  } finally { await h.stop(); }
});

test("native read failure never pretends recovery was clean or starts an assessment", async () => {
  const h = await harness({ nativeFailure: true });
  try {
    const receipt = await h.receipt("failed");
    expect(receipt.error).toBe("native-unavailable");
    expect(receipt.facts).toBeNull();
    h.send({ op: "send", sessionId: bossId, requestId: "native-failure", prompt: "Continue with my request." });
    const user = await h.prompt();
    expect(JSON.stringify(user.message.params.prompt)).toContain("Continue with my request.");
    user.finish();
    await h.assertSameBoss();
  } finally { await h.stop(); }
});

test("the real root subscribe path receives recovery even without warm-boss", async () => {
  const h = await harness({ facts: snapshot(), warm: false });
  try {
    await h.receipt("none");
    expect(h.peers.all.some((entry) => entry.message.method === "session/prompt")).toBe(false);
  } finally { await h.stop(); }
});

test("a clean restore arriving after visible input still reports that no assessment was needed", async () => {
  const h = await harness({ facts: snapshot("ended"), holdNative: true });
  try {
    h.send({ op: "user-input" });
    await h.barrier();
    h.releaseNative();
    const receipt = await h.receipt("none");
    expect(receipt.unresolved).toEqual([]);
    expect(h.peers.all.some((entry) => entry.message.method === "session/prompt")).toBe(false);
  } finally { await h.stop(); }
});

test("failed canonical warmup never reports a completed assessment or creates a replacement", async () => {
  const h = await harness({ loadFailure: true });
  try {
    const receipt = await h.receipt("failed");
    expect(receipt.error).toBe("assessment-failed");
    expect(receipt.facts).toEqual(snapshot("blocked_unverified"));
    expect(h.messages.all.some((message) => message.evt?.assessment === "completed")).toBe(false);
    expect(h.peers.all.some((entry) => entry.message.method === "session/prompt")).toBe(false);
    await h.assertSameBoss();
  } finally { await h.stop(); }
});

test("facts from another app instance fail closed rather than claiming a clean restore", async () => {
  const facts = snapshot();
  facts.topology.app_instance_id = "99999999-9999-4999-8999-999999999999";
  const h = await harness({ facts });
  try {
    const receipt = await h.receipt("failed");
    expect(receipt.error).toBe("native-unavailable");
    expect(receipt.facts).toBeNull();
    expect(h.peers.all.some((entry) => entry.message.method === "session/prompt")).toBe(false);
  } finally { await h.stop(); }
});

test("native event-stream failure keeps the last verified facts and does not retry assessment", async () => {
  const facts = snapshot("resuming");
  const h = await harness({ facts });
  try {
    await h.receipt("waiting");
    await h.native.next((request) => Array.isArray(request.stream));
    h.publish({ type: "error", code: "synthetic_stream_failure" });
    const receipt = await h.receipt("failed");
    expect(receipt.error).toBe("native-unavailable");
    expect(receipt.facts).toEqual(facts);
    h.send({ op: "warm-boss" });
    await h.barrier();
    expect(h.peers.all.some((entry) => entry.message.method === "session/prompt")).toBe(false);
  } finally { await h.stop(); }
});

test("a resumed shell's native state event completes recovery without waiting for an agent hook", async () => {
  const h = await harness({ facts: snapshot("resuming") });
  try {
    await h.receipt("waiting");
    await h.native.next((request) => Array.isArray(request.stream));
    h.setFacts(snapshot("running", "ready", 11));
    h.publish({ type: "event", name: "agent.restore.changed", category: "agent", seq: 11 });
    await h.receipt("none");
    expect(h.peers.all.some((entry) => entry.message.method === "session/prompt")).toBe(false);
  } finally { await h.stop(); }
});

test("a timed-out client reattaches to the admitted Boss when its first acknowledgment was lost", async () => {
  const h = await harness({ fresh: true });
  const frames = new Inbox<any>();
  const renders = new Inbox<SessionState>();
  let holdAcknowledgment = true;
  const client = await clientFixture(h.url, (message) => {
    frames.push(message);
    if (message.kind === "start-retired") holdAcknowledgment = false;
    return holdAcknowledgment && ["session-created", "history"].includes(message.kind);
  });
  let state: SessionState;
  function Root() { state = useSession(); renders.push(state); return null; }
  try {
    await client.render(createElement(Root));
    await renders.next((value) => value.ready);
    act(() => {
      expect(state.start({ provider: "ouro-boss", cwd: h.root, prompt: "Keep this relationship." })).toBe(true);
    });
    const first = await h.prompt();
    const acknowledged = await frames.next((message) => message.kind === "session-created");
    const id = acknowledged.session.id;
    expect(state.session?.id).not.toBe(id);
    await client.expireStartTimeout();
    await h.peers.next((entry) => entry.message.method === "session/cancel");
    first.finish({ stopReason: "cancelled" });
    const retained = await frames.next((message) => message.kind === "start-retired");
    await h.assertSameBoss(id, id);
    expect(retained.sessionId).toBe(id);
    await renders.next((value) => value.phase === "chat" && value.session?.id === id);

    let admitted: Promise<boolean>;
    act(() => { admitted = state.reply("Continue in this same Boss."); });
    const user = await h.prompt(1);
    await admitted;
    const cancels = h.peers.all.filter((entry) => entry.message.method === "session/cancel").length;
    h.send({ op: "cancel-start", requestId: acknowledged.requestId, retire: true });
    await h.messages.next((message) => message.kind === "start-retired" && message.requestId === acknowledged.requestId);
    expect(h.peers.all.filter((entry) => entry.message.method === "session/cancel")).toHaveLength(cancels);
    await h.assertSameBoss(id, id);
    h.send({ op: "start", requestId: acknowledged.requestId, provider: "ouro-boss", cwd: h.root, prompt: "Keep this relationship." });
    const replayed = await h.messages.next((message) => message.kind === "session-created" && message.requestId === acknowledged.requestId);
    expect(replayed.session.id).toBe(id);
    expect(h.peers.all.filter((entry) => entry.message.method === "session/prompt")).toHaveLength(2);
    user.finish();
  } finally { await client.stop(); await h.stop(); }
});

test("replayed retirement after server recovery preserves the established Boss record", async () => {
  const h = await harness({ startRequestId: "earlier-start", facts: snapshot() });
  try {
    h.send({ op: "cancel-start", requestId: "earlier-start", retire: true });
    const retained = await h.messages.next((message) => message.kind === "start-retired");
    await h.assertSameBoss();
    expect(JSON.parse(await readFile(join(h.root, "sessions/example-boss", `${bossId}.json`), "utf8")).providerSessionId)
      .toBe(peerSessionId);
    expect(retained.sessionId).toBe(bossId);
    h.send({ op: "send", sessionId: bossId, requestId: "same-after-replay", prompt: "Use the saved conversation." });
    const user = await h.prompt();
    expect(user.message.params.sessionId).toBe(peerSessionId);
    user.finish();
  } finally { await h.stop(); }
});

test("an unadmitted temporary Boss start can still be retired without leaving a relationship", async () => {
  const h = await harness({ fresh: true, holdInitialize: true });
  try {
    h.send({ op: "start", requestId: "temporary", provider: "ouro-boss", cwd: h.root, prompt: "Not admitted." });
    await h.peers.next((entry) => entry.message.method === "initialize");
    h.send({ op: "cancel-start", requestId: "temporary", retire: true });
    await h.messages.next((message) => message.kind === "start-retired");
    expect((await h.boss()).state.status).toBe("none");
    expect(h.peers.all.filter((entry) => entry.message.method === "session/prompt")).toHaveLength(0);
    h.releaseInitialize();
    h.send({ op: "start", requestId: "real-start", provider: "ouro-boss", cwd: h.root, prompt: "Begin the relationship." });
    const user = await h.prompt();
    await h.messages.next((message) => message.kind === "boss-state" && message.boss.status === "canonical");
    await h.assertSameBoss(user.message.params.sessionId, user.message.params.sessionId);
    user.finish();
  } finally { await h.stop(); }
});

for (const imageSupport of [true, false]) {
  test(`the fresh root client negotiates ${imageSupport ? "supported" : "unsupported"} images before first input`, async () => {
    const h = await harness({ fresh: true, holdInitialize: true, imageSupport });
    const renders = new Inbox<SessionState>();
    const client = await clientFixture(h.url);
    let state: SessionState;
    function Root() { state = useSession(); renders.push(state); return null; }
    try {
      await client.render(createElement(Root));
      await renders.next((value) => value.ready);
      expect(state.phase).toBe("composer");
      expect(state.boss?.status).toBe("none");
      expect(state.imageCapability).toBe("unknown");
      await h.peers.next((entry) => entry.message.method === "initialize");
      h.releaseInitialize();
      await renders.next((value) => value.imageCapability === (imageSupport ? "supported" : "unsupported"));
      expect(h.peers.all.filter((entry) => entry.message.method === "session/new")).toHaveLength(0);
      expect(h.peers.all.filter((entry) => entry.message.method === "session/prompt")).toHaveLength(0);

      const cwd = join(h.root, "selected");
      await mkdir(cwd);
      act(() => {
        expect(state.start({
          provider: "ouro-boss", cwd, prompt: "First request.",
          attachments: imageSupport ? [{ id: "image-1", name: "example.png", mimeType: "image/png", data: "cG5n", byteCount: 3 }] : [],
        })).toBe(true);
      });
      const user = await h.prompt();
      const created = h.peers.all.find((entry) => entry.message.method === "session/new")!;
      expect(created.message.params.cwd).toBe(cwd);
      expect(h.peers.all.filter((entry) => entry.message.method === "initialize")).toHaveLength(1);
      if (imageSupport) expect(user.message.params.prompt[0]).toEqual({ type: "image", mimeType: "image/png", data: "cG5n" });
      await renders.next((value) => value.boss?.status === "canonical");
      await h.assertSameBoss(user.message.params.sessionId, user.message.params.sessionId);
      user.finish();
    } finally { await client.stop(); await h.stop(); }
  });
}

test("a Boss startup reservation survives initialize until admission or retirement", async () => {
  const h = await harness({ fresh: true, holdInitialize: true });
  try {
    h.send({ op: "start", requestId: "first", provider: "ouro-boss", cwd: h.root, prompt: "First request." });
    await h.peers.next((entry) => entry.message.method === "initialize");
    h.send({ op: "start", requestId: "second", provider: "ouro-boss", cwd: h.root, prompt: "Must not replace it." });
    const rejected = await h.messages.next((message) => message.kind === "error" && message.requestId === "second");
    expect(rejected.message).toContain("Boss already exists");
    expect(h.peers.all.filter((entry) => entry.message.method === "initialize")).toHaveLength(1);
    h.send({ op: "cancel-start", requestId: "first", retire: true });
    await h.messages.next((message) => message.kind === "start-retired");
    expect((await h.boss()).state.status).toBe("none");
  } finally { await h.stop(); }
});

test("a failed unadmitted REST Boss start still releases its temporary session", async () => {
  const h = await harness({ fresh: true, holdInitialize: true });
  try {
    const failed = fetch(`${h.url}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "ouro-boss", cwd: h.root, prompt: "First request." }),
    });
    const initialize = await h.peers.next((entry) => entry.message.method === "initialize");
    initialize.finish({}, "synthetic initialize failure");
    h.releaseInitialize();
    expect((await failed).status).toBe(400);
    expect(await (await fetch(`${h.url}/api/sessions`)).json()).toEqual([]);
    expect((await h.boss()).state.status).toBe("none");
  } finally { await h.stop(); }
});

test("fresh root negotiation failure stays visible and a text start can retry", async () => {
  const h = await harness({ fresh: true, holdInitialize: true });
  const renders = new Inbox<SessionState>();
  const client = await clientFixture(h.url);
  let state: SessionState;
  function Root() { state = useSession(); renders.push(state); return null; }
  try {
    await client.render(createElement(Root));
    const initialize = await h.peers.next((entry) => entry.message.method === "initialize");
    initialize.finish({}, "synthetic initialize failure");
    h.releaseInitialize();
    await renders.next((value) => Boolean(value.lastError));
    expect(state.phase).toBe("composer");
    expect(state.imageCapability).toBe("unknown");
    expect(h.peers.all.filter((entry) => entry.message.method === "session/new")).toHaveLength(0);
    act(() => { expect(state.start({ provider: "ouro-boss", cwd: h.root, prompt: "Retry with text." })).toBe(true); });
    const user = await h.prompt();
    await renders.next((value) => value.boss?.status === "canonical");
    expect(h.peers.all.filter((entry) => entry.message.method === "initialize")).toHaveLength(2);
    await h.assertSameBoss(user.message.params.sessionId, user.message.params.sessionId);
    user.finish();
  } finally { await client.stop(); await h.stop(); }
});

test("duplicate fresh-root warmups and input during initialize share one Boss peer", async () => {
  const h = await harness({ fresh: true, holdInitialize: true });
  const renders = new Inbox<SessionState>();
  const client = await clientFixture(h.url);
  let state: SessionState;
  function Root() { state = useSession(); renders.push(state); return null; }
  try {
    await client.render(createElement(Root));
    await h.peers.next((entry) => entry.message.method === "initialize");
    h.send({ op: "warm-boss" });
    h.send({ op: "warm-boss" });
    act(() => { expect(state.start({ provider: "ouro-boss", cwd: h.root, prompt: "Start while connecting." })).toBe(true); });
    h.releaseInitialize();
    const user = await h.prompt();
    await renders.next((value) => value.boss?.status === "canonical");
    expect(h.peers.all.filter((entry) => entry.message.method === "initialize")).toHaveLength(1);
    await h.assertSameBoss(user.message.params.sessionId, user.message.params.sessionId);
    user.finish();
  } finally { await client.stop(); await h.stop(); }
});
