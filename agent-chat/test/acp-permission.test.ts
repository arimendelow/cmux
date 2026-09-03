import { expect, test } from "bun:test";
import { makeAcpAdapter } from "../adapters/acp";
import type { AgentEvent, ProviderDef, SessionCtx, SessionStatus } from "../types";

function waitForEvent(events: AgentEvent[], kind: AgentEvent["kind"], timeoutMs = 1_000): Promise<AgentEvent> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const event = events.find((candidate) => candidate.kind === kind);
      if (event) {
        clearInterval(timer);
        resolve(event);
      } else if (Date.now() - started >= timeoutMs) {
        clearInterval(timer);
        reject(new Error(`timed out waiting for ${kind}`));
      }
    }, 5);
  });
}

test("ACP permission request waits for one correlated response", async () => {
  const definition: ProviderDef = {
    id: "permission-acp",
    label: "Permission ACP",
    adapter: "acp",
    cmd: ["bun", `${import.meta.dir}/fake-acp.ts`, "--request-permission"],
  };
  const adapter = makeAcpAdapter(definition);
  const events: AgentEvent[] = [];
  const context: SessionCtx = {
    id: "permission-session",
    provider: definition.id,
    cwd: `${import.meta.dir}/../scratch`,
    title: "permission",
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
    const turn = Promise.resolve(adapter.send(context, "read the greeting"));
    const request = await waitForEvent(events, "permission-request");
    expect(request).toEqual({
      kind: "permission-request",
      requestId: "99",
      title: "Read greeting.mjs",
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" },
      ],
    });
    await adapter.respondPermission?.(context, "99", "allow-once");
    await turn;
    expect(events).toContainEqual({
      kind: "permission-resolved",
      requestId: "99",
      optionId: "allow-once",
    });
    expect(events).toContainEqual({ kind: "delta", text: "allow-once" });
    await expect(adapter.respondPermission?.(context, "99", "allow-once")).rejects.toThrow("permission request not found");
  } finally {
    adapter.dispose(context);
  }
});
