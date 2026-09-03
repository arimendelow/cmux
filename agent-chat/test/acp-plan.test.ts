import { expect, test } from "bun:test";
import { makeAcpAdapter } from "../adapters/acp";
import type { AgentEvent, ProviderDef, SessionCtx, SessionStatus } from "../types";

test("ACP preserves structured plan entries", async () => {
  const definition: ProviderDef = {
    id: "plan-acp",
    label: "Plan ACP",
    adapter: "acp",
    cmd: ["bun", `${import.meta.dir}/fake-acp.ts`, "--emit-plan"],
  };
  const adapter = makeAcpAdapter(definition);
  const events: AgentEvent[] = [];
  const context: SessionCtx = {
    id: "plan-session",
    provider: definition.id,
    cwd: `${import.meta.dir}/../scratch`,
    title: "plan",
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

  try {
    await adapter.send(context, "make a plan");
    expect(events).toContainEqual({
      kind: "plan",
      entries: [
        { content: "Inspect the greeting", status: "completed" },
        { content: "Update the message", status: "in_progress" },
        { content: "Run the check", status: "pending" },
      ],
    });
    expect(events.some((event) => event.kind === "status" && event.text.startsWith("plan:"))).toBe(false);
  } finally {
    adapter.dispose(context);
  }
});
