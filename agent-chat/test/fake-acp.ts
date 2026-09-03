import { appendFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";

const modelFlag = Bun.argv.findIndex((arg) => arg === "--model");
const model = modelFlag >= 0 ? Bun.argv[modelFlag + 1] ?? "" : "";
const startupDelayFlag = Bun.argv.findIndex((arg) => arg === "--startup-delay-ms");
const startupDelayMs = startupDelayFlag >= 0 ? Number(Bun.argv[startupDelayFlag + 1] ?? "0") : 0;
const slowPromptFlag = Bun.argv.findIndex((arg) => arg === "--slow-prompt-ms");
const slowPromptMs = slowPromptFlag >= 0 ? Number(Bun.argv[slowPromptFlag + 1] ?? "0") : 0;
const failLoad = Bun.argv.includes("--fail-load");
const requestPermission = Bun.argv.includes("--request-permission");
const exitAfterPermission = Bun.argv.includes("--exit-after-permission");
const requestElicitation = Bun.argv.includes("--request-elicitation");
const emitPlan = Bun.argv.includes("--emit-plan");
const emitUpdateDispositions = Bun.argv.includes("--emit-update-dispositions");
const log = process.env.FAKE_ACP_MODEL_LOG;
const methodLog = process.env.FAKE_ACP_METHOD_LOG;
const pidFile = process.env.FAKE_ACP_PID_FILE;
if (log) await appendFile(log, `${model}\n`);
if (pidFile) await writeFile(pidFile, `${process.pid}\n`);

const rl = createInterface({ input: process.stdin });
let pendingPromptId: number | string | null = null;
let pendingPromptTimer: ReturnType<typeof setTimeout> | null = null;
const send = (msg: unknown) => {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
};

for await (const line of rl) {
  if (!line.trim()) continue;
  const msg = JSON.parse(line);
  if (methodLog && msg.method) await appendFile(methodLog, `${msg.method}\n`);
  if (msg.method === "initialize") {
    if (startupDelayMs > 0) await Bun.sleep(startupDelayMs);
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } });
  } else if (msg.method === "session/new") {
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: `fake-${model || "default"}` } });
  } else if (msg.method === "session/load") {
    if (failLoad) {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32001, message: "session not found" } });
      continue;
    }
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: msg.params.sessionId,
        update: {
          sessionUpdate: "user_message_chunk",
          messageId: "user-1",
          content: { type: "text", text: "previous question" },
        },
      },
    });
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: msg.params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "agent-1",
          content: { type: "text", text: "previous answer" },
        },
      },
    });
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
  } else if (msg.method === "session/prompt") {
    if (emitUpdateDispositions) {
      for (const update of [
        { sessionUpdate: "session_info_update", title: "sensitive title" },
        { sessionUpdate: "usage_update", inputTokens: 123456 },
        { sessionUpdate: "mystery_update", secret: "do not surface" },
        { sessionUpdate: "mystery_update", secret: "still do not surface" },
        ...Array.from({ length: 20 }, (_, index) => ({
          sessionUpdate: `unique_${index}_${"x".repeat(200)}`,
        })),
      ]) {
        send({ jsonrpc: "2.0", method: "session/update", params: { update } });
      }
    }
    if (emitPlan) {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "plan",
            entries: [
              { content: "Inspect the greeting", status: "completed" },
              { content: "Update the message", status: "in_progress" },
              { content: "Run the check", status: "pending" },
            ],
          },
        },
      });
    }
    if (requestPermission) {
      pendingPromptId = msg.id;
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "tool-1",
            title: "Read greeting.mjs",
            kind: "read",
            status: "pending",
          },
        },
      });
      send({
        jsonrpc: "2.0",
        id: 99,
        method: "session/request_permission",
        params: {
          sessionId: `fake-${model || "default"}`,
          toolCall: { toolCallId: "tool-1" },
          options: [
            { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
            { optionId: "reject-once", name: "Reject", kind: "reject_once" },
          ],
        },
      });
      if (exitAfterPermission) setTimeout(() => process.exit(0), 10);
      continue;
    }
    if (requestElicitation) {
      pendingPromptId = msg.id;
      send({
        jsonrpc: "2.0",
        id: 100,
        method: "elicitation/create",
        params: {
          sessionId: `fake-${model || "default"}`,
          mode: "form",
          message: "How should I update the greeting?",
          requestedSchema: {
            type: "object",
            properties: {
              strategy: {
                type: "string",
                title: "Strategy",
                enum: ["conservative", "balanced"],
                default: "balanced",
              },
              includeCheck: {
                type: "boolean",
                title: "Run the check",
                default: true,
              },
            },
            required: ["strategy"],
          },
        },
      });
      continue;
    }
    if (slowPromptMs > 0) {
      pendingPromptId = msg.id;
      pendingPromptTimer = setTimeout(() => {
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "OK" } } },
        });
        send({ jsonrpc: "2.0", id: pendingPromptId, result: { stopReason: "end_turn" } });
        pendingPromptId = null;
        pendingPromptTimer = null;
      }, slowPromptMs);
      continue;
    }
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "OK" } } },
    });
    send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
  } else if (msg.method === "session/cancel" && pendingPromptId !== null) {
    if (pendingPromptTimer) clearTimeout(pendingPromptTimer);
    pendingPromptTimer = null;
    send({ jsonrpc: "2.0", id: pendingPromptId, result: { stopReason: "cancelled" } });
    pendingPromptId = null;
  } else if (msg.id === 99 && msg.result && pendingPromptId !== null) {
    const selected = msg.result.outcome?.optionId ?? "cancelled";
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "tool-1",
          status: selected === "allow-once" ? "completed" : "failed",
          content: [{ type: "content", content: { type: "text", text: selected } }],
        },
      },
    });
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: selected } } },
    });
    send({ jsonrpc: "2.0", id: pendingPromptId, result: { stopReason: "end_turn" } });
    pendingPromptId = null;
  } else if (msg.id === 100 && msg.result && pendingPromptId !== null) {
    const result = msg.result;
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `${result.action}:${JSON.stringify(result.content ?? null)}` },
        },
      },
    });
    send({ jsonrpc: "2.0", id: pendingPromptId, result: { stopReason: "end_turn" } });
    pendingPromptId = null;
  } else if (msg.id != null) {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
  }
}
