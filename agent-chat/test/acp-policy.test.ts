import { expect, test } from "bun:test";
import { makeAcpAdapter } from "../adapters/acp";
import type { AgentEvent, ProviderDef, SessionCtx, SessionStatus } from "../types";

function session(provider: string): SessionCtx {
  const events: AgentEvent[] = [];
  return {
    id: "policy-test",
    provider,
    cwd: `${import.meta.dir}/../scratch`,
    title: "policy",
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

test("ACP defaults to approval required", () => {
  const adapter = makeAcpAdapter({
    id: "safe-acp",
    label: "Safe ACP",
    adapter: "acp",
    cmd: ["bun", `${import.meta.dir}/fake-acp.ts`],
  });

  expect(adapter.capabilities?.options.find((option) => option.id === "autoApprove")?.value).toBe(false);
});

test("ACP honors a provider startup timeout", async () => {
  const definition: ProviderDef = {
    id: "slow-acp",
    label: "Slow ACP",
    adapter: "acp",
    cmd: ["bun", `${import.meta.dir}/fake-acp.ts`, "--startup-delay-ms", "40"],
    startupTimeoutMs: 10,
  };
  const adapter = makeAcpAdapter(definition);
  const context = session(definition.id);

  try {
    await expect(adapter.refreshOptions?.(context)).rejects.toThrow("did not finish ACP startup");
  } finally {
    adapter.dispose(context);
  }
});

test("ACP can defer disposable catalog probes", async () => {
  const adapter = makeAcpAdapter({
    id: "deferred-acp",
    label: "Deferred ACP",
    adapter: "acp",
    cmd: ["/missing/deferred-acp"],
    probeCatalogs: false,
  });

  expect(await adapter.listOptions?.("/tmp")).toEqual(adapter.capabilities?.options);
  expect(await adapter.listCommands?.("/tmp")).toEqual([{ trigger: "/", commands: [] }]);
});
