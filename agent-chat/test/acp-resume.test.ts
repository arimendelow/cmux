import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { makeAcpAdapter } from "../adapters/acp";
import type { AgentEvent, ProviderDef, SessionCtx, SessionStatus } from "../types";

test("ACP loads a persisted provider session and replays its conversation", async () => {
  const log = `${import.meta.dir}/../scratch/fake-acp-methods.log`;
  await writeFile(log, "");
  const previous = process.env.FAKE_ACP_METHOD_LOG;
  process.env.FAKE_ACP_METHOD_LOG = log;
  const definition: ProviderDef = {
    id: "resume-acp",
    label: "Resume ACP",
    adapter: "acp",
    cmd: ["bun", `${import.meta.dir}/fake-acp.ts`],
  };
  const adapter = makeAcpAdapter(definition);
  const events: AgentEvent[] = [];
  const context: SessionCtx = {
    id: "resume-session",
    provider: definition.id,
    cwd: `${import.meta.dir}/../scratch`,
    title: "resume",
    autoApprove: false,
    startOptions: {},
    status: "idle",
    events,
    internal: {
      acpResumeSessionId: "persisted-session",
      productId: "ouro-workbench-v1",
      restoredFromDisk: true,
    },
    emit(event) {
      events.push(event);
    },
    setStatus(status: SessionStatus) {
      this.status = status;
    },
  };

  try {
    await adapter.refreshOptions?.(context);
    expect((await readFile(log, "utf8")).trim().split(/\n+/)).toEqual(["initialize", "session/load"]);
    expect(events).toContainEqual({ kind: "user", text: "previous question" });
    expect(events).toContainEqual({ kind: "delta", text: "previous answer" });
    expect(events).toContainEqual({ kind: "meta", providerSessionId: "persisted-session" });
    expect(events).toContainEqual({
      kind: "recovery",
      mode: "resumed",
      title: "Conversation resumed",
      message: "Loaded the existing provider session after Workbench restarted.",
    });

  } finally {
    adapter.dispose(context);
    if (previous === undefined) delete process.env.FAKE_ACP_METHOD_LOG;
    else process.env.FAKE_ACP_METHOD_LOG = previous;
  }
});

test("ACP live reconnect does not append a second copy of the transcript", async () => {
  const definition: ProviderDef = {
    id: "live-reconnect-acp",
    label: "Live Reconnect ACP",
    adapter: "acp",
    cmd: ["bun", `${import.meta.dir}/fake-acp.ts`],
  };
  const adapter = makeAcpAdapter(definition);
  const events: AgentEvent[] = [
    { kind: "user", text: "previous question" },
    { kind: "delta", text: "previous answer" },
  ];
  const context: SessionCtx = {
    id: "live-reconnect-session",
    provider: definition.id,
    cwd: `${import.meta.dir}/../scratch`,
    title: "live reconnect",
    autoApprove: false,
    startOptions: {},
    status: "idle",
    events,
    internal: { acpResumeSessionId: "persisted-session", productId: "ouro-workbench-v1" },
    emit(event) {
      events.push(event);
    },
    setStatus(status: SessionStatus) {
      this.status = status;
    },
  };

  try {
    await adapter.refreshOptions?.(context);
    expect(events.filter((event) => event.kind === "user")).toHaveLength(1);
    expect(events.filter((event) => event.kind === "delta")).toHaveLength(1);
    expect(events).toContainEqual({
      kind: "recovery",
      mode: "resumed",
      title: "Conversation resumed",
      message: "Reconnected to the existing provider session.",
    });
  } finally {
    adapter.dispose(context);
  }
});

test("ACP replaces an unloadable persisted session with an honest fresh conversation", async () => {
  const log = `${import.meta.dir}/../scratch/fake-acp-respawn-methods.log`;
  await writeFile(log, "");
  const previous = process.env.FAKE_ACP_METHOD_LOG;
  process.env.FAKE_ACP_METHOD_LOG = log;
  const definition: ProviderDef = {
    id: "respawn-acp",
    label: "Respawn ACP",
    adapter: "acp",
    cmd: ["bun", `${import.meta.dir}/fake-acp.ts`, "--fail-load"],
  };
  const adapter = makeAcpAdapter(definition);
  const events: AgentEvent[] = [];
  let invalidations = 0;
  const context: SessionCtx = {
    id: "respawn-session",
    provider: definition.id,
    cwd: `${import.meta.dir}/../scratch`,
    title: "respawn",
    autoApprove: false,
    startOptions: {},
    status: "idle",
    events,
    internal: { acpResumeSessionId: "missing-session", productId: "ouro-workbench-v1" },
    emit(event) {
      events.push(event);
    },
    setStatus(status: SessionStatus) {
      this.status = status;
    },
    async invalidatePersistedSession() {
      invalidations += 1;
    },
  };

  try {
    await adapter.refreshOptions?.(context);
    expect((await readFile(log, "utf8")).trim().split(/\n+/)).toEqual([
      "initialize",
      "session/load",
      "session/new",
    ]);
    expect(invalidations).toBe(1);
    expect(context.internal.acpResumeSessionId).toBe("fake-default");
    expect(events).toContainEqual({
      kind: "recovery",
      mode: "respawned",
      title: "Started a fresh conversation",
      message: "The previous provider session could not be loaded.",
    });
  } finally {
    adapter.dispose(context);
    if (previous === undefined) delete process.env.FAKE_ACP_METHOD_LOG;
    else process.env.FAKE_ACP_METHOD_LOG = previous;
  }
});
