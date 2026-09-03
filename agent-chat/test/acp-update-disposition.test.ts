import { expect, test } from "bun:test";
import { makeAcpAdapter } from "../adapters/acp";
import type { AgentEvent, ProviderDef, SessionCtx, SessionStatus } from "../types";

test("ACP ignores safe metadata updates and reports each unknown update once", async () => {
  const definition: ProviderDef = {
    id: "update-disposition-acp",
    label: "Update Disposition ACP",
    adapter: "acp",
    cmd: ["bun", `${import.meta.dir}/fake-acp.ts`, "--emit-update-dispositions"],
  };
  const adapter = makeAcpAdapter(definition);
  const events: AgentEvent[] = [];
  const context: SessionCtx = {
    id: "update-disposition-session",
    provider: definition.id,
    cwd: `${import.meta.dir}/../scratch`,
    title: "updates",
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
    await adapter.send(context, "emit updates");
    expect(events.filter(
      (event) => event.kind === "status" && event.text === "Unsupported ACP session update: mystery_update",
    )).toHaveLength(1);
    const unsupported = events.filter(
      (event): event is Extract<AgentEvent, { kind: "status" }> =>
        event.kind === "status" && event.text.startsWith("Unsupported ACP session update:"),
    );
    expect(unsupported).toHaveLength(16);
    expect(unsupported.every((event) => event.text.length <= 120)).toBe(true);
    expect(JSON.stringify(events)).not.toContain("sensitive title");
    expect(JSON.stringify(events)).not.toContain("123456");
  } finally {
    adapter.dispose(context);
  }
});
