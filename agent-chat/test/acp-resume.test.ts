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
