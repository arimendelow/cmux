import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { makeAcpAdapter } from "../adapters/acp";
import type {
  AgentEvent,
  PromptAttachment,
  ProviderDef,
  SessionCtx,
  SessionStatus,
} from "../types";

function context(provider: string): SessionCtx {
  const events: AgentEvent[] = [];
  return {
    id: `image-${provider}`,
    provider,
    cwd: `${import.meta.dir}/../scratch`,
    title: "image",
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

test("ACP adapter negotiates and sends standard image content blocks", async () => {
  const log = `${import.meta.dir}/../scratch/fake-acp-image-prompts.log`;
  await writeFile(log, "");
  const previousLog = process.env.FAKE_ACP_PROMPT_LOG;
  const previousSupport = process.env.FAKE_ACP_IMAGE_SUPPORT;
  process.env.FAKE_ACP_PROMPT_LOG = log;
  process.env.FAKE_ACP_IMAGE_SUPPORT = "1";
  const definition: ProviderDef = {
    id: "image-acp",
    label: "Image ACP",
    adapter: "acp",
    cmd: ["bun", `${import.meta.dir}/fake-acp.ts`],
  };
  const adapter = makeAcpAdapter(definition);
  const session = context(definition.id);
  const attachment: PromptAttachment = {
    id: "image-1",
    name: "screenshot.png",
    mimeType: "image/png",
    data: "cG5n",
    byteCount: 3,
  };

  try {
    await adapter.send(session, "inspect this", 1, [attachment]);
    const prompt = JSON.parse((await readFile(log, "utf8")).trim());
    expect(prompt.prompt).toEqual([
      {
        type: "image",
        mimeType: "image/png",
        data: "cG5n",
      },
      { type: "text", text: "inspect this" },
    ]);
  } finally {
    adapter.dispose(session);
    if (previousLog === undefined) delete process.env.FAKE_ACP_PROMPT_LOG;
    else process.env.FAKE_ACP_PROMPT_LOG = previousLog;
    if (previousSupport === undefined) delete process.env.FAKE_ACP_IMAGE_SUPPORT;
    else process.env.FAKE_ACP_IMAGE_SUPPORT = previousSupport;
  }
});

test("ACP adapter rejects image blocks after unsupported capability negotiation", async () => {
  const definition: ProviderDef = {
    id: "text-acp",
    label: "Text ACP",
    adapter: "acp",
    cmd: ["bun", `${import.meta.dir}/fake-acp.ts`, "--no-image-support"],
  };
  const adapter = makeAcpAdapter(definition);
  const session = context(definition.id);

  try {
    await expect(adapter.preparePromptAttachments?.(session, [{
      id: "image-preflight",
      name: "screenshot.png",
      mimeType: "image/png",
      data: "cG5n",
      byteCount: 3,
    }])).rejects.toThrow("does not support image prompts");
    expect(session.events.some((event) => event.kind === "meta")).toBe(false);
    await adapter.send(session, "", 1, [{
      id: "image-1",
      name: "screenshot.png",
      mimeType: "image/png",
      data: "cG5n",
      byteCount: 3,
    }]);
    expect(session.events).toContainEqual(
      expect.objectContaining({
        kind: "error",
        message: expect.stringContaining("does not support image prompts"),
      }),
    );
  } finally {
    adapter.dispose(session);
  }
});

test("ACP adapter sends an image-only prompt", async () => {
  const log = `${import.meta.dir}/../scratch/fake-acp-image-only.log`;
  await writeFile(log, "");
  const previousLog = process.env.FAKE_ACP_PROMPT_LOG;
  const previousSupport = process.env.FAKE_ACP_IMAGE_SUPPORT;
  process.env.FAKE_ACP_PROMPT_LOG = log;
  process.env.FAKE_ACP_IMAGE_SUPPORT = "1";
  const definition: ProviderDef = {
    id: "image-only-acp",
    label: "Image-only ACP",
    adapter: "acp",
    cmd: ["bun", `${import.meta.dir}/fake-acp.ts`],
  };
  const adapter = makeAcpAdapter(definition);
  const session = context(definition.id);
  try {
    await adapter.send(session, "", 1, [{
      id: "image-only",
      name: "photo.webp",
      mimeType: "image/webp",
      data: "d2VicA==",
      byteCount: 4,
    }]);
    expect(JSON.parse((await readFile(log, "utf8")).trim()).prompt).toEqual([{
      type: "image",
      mimeType: "image/webp",
      data: "d2VicA==",
    }]);
  } finally {
    adapter.dispose(session);
    if (previousLog === undefined) delete process.env.FAKE_ACP_PROMPT_LOG;
    else process.env.FAKE_ACP_PROMPT_LOG = previousLog;
    if (previousSupport === undefined) delete process.env.FAKE_ACP_IMAGE_SUPPORT;
    else process.env.FAKE_ACP_IMAGE_SUPPORT = previousSupport;
  }
});

test("ACP adapter renegotiates image capability after process respawn", async () => {
  const previousSupport = process.env.FAKE_ACP_IMAGE_SUPPORT;
  process.env.FAKE_ACP_IMAGE_SUPPORT = "1";
  const definition: ProviderDef = {
    id: "respawn-image-acp",
    label: "Respawn image ACP",
    adapter: "acp",
    cmd: ["bun", `${import.meta.dir}/fake-acp.ts`],
  };
  const adapter = makeAcpAdapter(definition);
  const session = context(definition.id);
  const attachment: PromptAttachment = {
    id: "image-respawn",
    name: "screenshot.png",
    mimeType: "image/png",
    data: "cG5n",
    byteCount: 3,
  };
  try {
    await adapter.send(session, "first", 1, [attachment]);
    adapter.dispose(session);
    process.env.FAKE_ACP_IMAGE_SUPPORT = "0";
    let admitted = false;
    await expect(adapter.sendWithAdmission?.(
      session,
      "second",
      2,
      [attachment],
      () => { admitted = true; },
    )).rejects.toThrow("does not support image prompts");
    expect(admitted).toBe(false);
  } finally {
    adapter.dispose(session);
    if (previousSupport === undefined) delete process.env.FAKE_ACP_IMAGE_SUPPORT;
    else process.env.FAKE_ACP_IMAGE_SUPPORT = previousSupport;
  }
});

test("ACP admission resolves after prompt dispatch without waiting for turn completion", async () => {
  const definition: ProviderDef = {
    id: "slow-image-acp",
    label: "Slow image ACP",
    adapter: "acp",
    cmd: ["bun", `${import.meta.dir}/fake-acp.ts`, "--slow-prompt-ms", "500"],
  };
  const adapter = makeAcpAdapter(definition);
  const session = context(definition.id);
  let admitted = false;

  try {
    await adapter.sendWithAdmission?.(
      session,
      "inspect",
      1,
      [{
        id: "slow-image",
        name: "slow.png",
        mimeType: "image/png",
        data: "cG5n",
        byteCount: 3,
      }],
      () => { admitted = true; },
    );
    expect(admitted).toBe(true);
    expect(session.status).toBe("running");
  } finally {
    adapter.stop(session);
    adapter.dispose(session);
  }
});
