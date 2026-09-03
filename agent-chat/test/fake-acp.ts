import { appendFile } from "node:fs/promises";
import { createInterface } from "node:readline";

const modelFlag = Bun.argv.findIndex((arg) => arg === "--model");
const model = modelFlag >= 0 ? Bun.argv[modelFlag + 1] ?? "" : "";
const startupDelayFlag = Bun.argv.findIndex((arg) => arg === "--startup-delay-ms");
const startupDelayMs = startupDelayFlag >= 0 ? Number(Bun.argv[startupDelayFlag + 1] ?? "0") : 0;
const requestPermission = Bun.argv.includes("--request-permission");
const log = process.env.FAKE_ACP_MODEL_LOG;
if (log) await appendFile(log, `${model}\n`);

const rl = createInterface({ input: process.stdin });
let pendingPromptId: number | string | null = null;
const send = (msg: unknown) => {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
};

for await (const line of rl) {
  if (!line.trim()) continue;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    if (startupDelayMs > 0) await Bun.sleep(startupDelayMs);
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } });
  } else if (msg.method === "session/new") {
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: `fake-${model || "default"}` } });
  } else if (msg.method === "session/prompt") {
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
      continue;
    }
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "OK" } } },
    });
    send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
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
  } else if (msg.id != null) {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
  }
}
