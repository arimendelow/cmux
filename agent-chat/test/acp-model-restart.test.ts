import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { makeAcpAdapter } from "../adapters/acp";
import type { AgentEvent, ProviderDef, SessionCtx, SessionStatus } from "../types";

test("spawn-model changes create a fresh provider session", async () => {
  const methodLog = `${import.meta.dir}/../scratch/fake-acp-model-restart-methods.log`;
  const modelLog = `${import.meta.dir}/../scratch/fake-acp-model-restart-models.log`;
  await writeFile(methodLog, "");
  await writeFile(modelLog, "");
  const previousMethodLog = process.env.FAKE_ACP_METHOD_LOG;
  const previousModelLog = process.env.FAKE_ACP_MODEL_LOG;
  process.env.FAKE_ACP_METHOD_LOG = methodLog;
  process.env.FAKE_ACP_MODEL_LOG = modelLog;
  const definition: ProviderDef = {
    id: "spawn-model-acp",
    label: "Spawn Model ACP",
    adapter: "acp",
    cmd: ["bun", `${import.meta.dir}/fake-acp.ts`],
    models: [
      { value: "m1", label: "Model 1" },
      { value: "m2", label: "Model 2" },
    ],
    defaultModel: "m1",
  };
  const adapter = makeAcpAdapter(definition);
  const events: AgentEvent[] = [];
  const session: SessionCtx = {
    id: "spawn-model-session",
    provider: definition.id,
    cwd: `${import.meta.dir}/../scratch`,
    title: "model restart",
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
    await adapter.refreshOptions?.(session);
    await adapter.setOption(session, "model", "m2");
    expect((await readFile(methodLog, "utf8")).trim().split(/\n+/)).toEqual([
      "initialize",
      "session/new",
      "initialize",
      "session/new",
    ]);
    expect((await readFile(modelLog, "utf8")).trim().split(/\n+/)).toEqual(["m1", "m2"]);
    expect(events.some((event) => event.kind === "recovery")).toBe(false);
  } finally {
    adapter.dispose(session);
    if (previousMethodLog === undefined) delete process.env.FAKE_ACP_METHOD_LOG;
    else process.env.FAKE_ACP_METHOD_LOG = previousMethodLog;
    if (previousModelLog === undefined) delete process.env.FAKE_ACP_MODEL_LOG;
    else process.env.FAKE_ACP_MODEL_LOG = previousModelLog;
  }
});
