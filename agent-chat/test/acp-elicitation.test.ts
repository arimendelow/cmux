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

test("ACP form elicitation waits for one correlated response", async () => {
  const definition: ProviderDef = {
    id: "elicitation-acp",
    label: "Elicitation ACP",
    adapter: "acp",
    cmd: ["bun", `${import.meta.dir}/fake-acp.ts`, "--request-elicitation"],
  };
  const adapter = makeAcpAdapter(definition);
  const events: AgentEvent[] = [];
  const context: SessionCtx = {
    id: "elicitation-session",
    provider: definition.id,
    cwd: `${import.meta.dir}/../scratch`,
    title: "elicitation",
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
    const turn = Promise.resolve(adapter.send(context, "ask me"));
    const request = await waitForEvent(events, "elicitation-request");
    expect(request).toEqual({
      kind: "elicitation-request",
      requestId: "100",
      message: "How should I update the greeting?",
      fields: [
        {
          name: "strategy",
          type: "string",
          title: "Strategy",
          required: true,
          options: ["conservative", "balanced"],
          defaultValue: "balanced",
        },
        {
          name: "includeCheck",
          type: "boolean",
          title: "Run the check",
          required: false,
          defaultValue: true,
        },
      ],
    });
    await adapter.respondElicitation?.(context, "100", "accept", {
      strategy: "conservative",
      includeCheck: true,
    });
    await turn;
    expect(events).toContainEqual({
      kind: "elicitation-resolved",
      requestId: "100",
      action: "accept",
    });
    expect(events).toContainEqual({
      kind: "delta",
      text: 'accept:{"strategy":"conservative","includeCheck":true}',
    });
    await expect(adapter.respondElicitation?.(context, "100", "accept", {})).rejects.toThrow("elicitation request not found");
  } finally {
    adapter.dispose(context);
  }
});
