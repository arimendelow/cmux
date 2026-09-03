import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { makeAcpAdapter } from "../adapters/acp";
import type { AgentEvent, ProviderDef, SessionCtx, SessionStatus } from "../types";

function context(provider: string): SessionCtx {
  const events: AgentEvent[] = [];
  return {
    id: `cancel-${provider}`,
    provider,
    cwd: `${import.meta.dir}/../scratch`,
    title: "cancel",
    autoApprove: false,
    startOptions: {},
    status: "idle",
    events,
    internal: {},
    emit(event) {
      events.push(event);
    },
    setStatus(status: SessionStatus) {
      this.status = status;
    },
  };
}

async function waitForLog(log: string, needle: string) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if ((await readFile(log, "utf8")).includes(needle)) return;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${needle}`);
}

test("ACP stop cancels an active turn and a later prompt still succeeds", async () => {
  const log = `${import.meta.dir}/../scratch/fake-acp-cancel-methods.log`;
  await writeFile(log, "");
  const previous = process.env.FAKE_ACP_METHOD_LOG;
  process.env.FAKE_ACP_METHOD_LOG = log;
  const definition: ProviderDef = {
    id: "cancel-acp",
    label: "Cancel ACP",
    adapter: "acp",
    cmd: ["bun", `${import.meta.dir}/fake-acp.ts`, "--slow-prompt-ms", "120"],
  };
  const adapter = makeAcpAdapter(definition);
  const session = context(definition.id);

  try {
    const first = adapter.send(session, "cancel this turn");
    await waitForLog(log, "session/prompt");
    adapter.stop(session);
    await first;
    expect((await readFile(log, "utf8")).trim().split(/\n+/)).toContain("session/cancel");
    expect(session.status).toBe("idle");
    await adapter.send(session, "later prompt");
    expect(session.events).toContainEqual({ kind: "delta", text: "OK" });
  } finally {
    adapter.dispose(session);
    if (previous === undefined) delete process.env.FAKE_ACP_METHOD_LOG;
    else process.env.FAKE_ACP_METHOD_LOG = previous;
  }
});

test("ACP stop terminates a provider that is still starting", async () => {
  const definition: ProviderDef = {
    id: "starting-acp",
    label: "Starting ACP",
    adapter: "acp",
    cmd: ["bun", `${import.meta.dir}/fake-acp.ts`, "--startup-delay-ms", "1000"],
    startupTimeoutMs: 5_000,
  };
  const adapter = makeAcpAdapter(definition);
  const session = context(definition.id);

  try {
    const starting = adapter.refreshOptions?.(session);
    await Bun.sleep(30);
    adapter.stop(session);
    await expect(starting).rejects.toThrow("process exited");
  } finally {
    adapter.dispose(session);
  }
});
