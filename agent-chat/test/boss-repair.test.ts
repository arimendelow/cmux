import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveBaseUrl, runBossRepair } from "../boss-repair";

test("Boss repair resolves explicit and state-file coordinates without using a live profile", async () => {
  const root = await mkdtemp(join(tmpdir(), "boss-repair-coordinates-"));
  const stateFile = join(root, "state.json");
  const previous = {
    CMUX_AGENT_CHAT_BASE_URL: process.env.CMUX_AGENT_CHAT_BASE_URL,
    CMUX_AGENT_CHAT_STATE_FILE: process.env.CMUX_AGENT_CHAT_STATE_FILE,
    CMUX_AGENT_CHAT_TOKEN: process.env.CMUX_AGENT_CHAT_TOKEN,
  };
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("owned") });
  try {
    await writeFile(stateFile, JSON.stringify({ port: server.port }));
    const base = `http://127.0.0.1:${server.port}`;
    expect(await resolveBaseUrl({ CMUX_AGENT_CHAT_BASE_URL: `${base}/` })).toBe(base);
    expect(await resolveBaseUrl({}, stateFile)).toBe(base);
    expect(await resolveBaseUrl({ CMUX_AGENT_CHAT_TOKEN: "space token/segment" }, stateFile))
      .toBe(`${base}/space%20token%2Fsegment`);
    delete process.env.CMUX_AGENT_CHAT_BASE_URL;
    process.env.CMUX_AGENT_CHAT_STATE_FILE = stateFile;
    process.env.CMUX_AGENT_CHAT_TOKEN = "owned-token";
    expect(await resolveBaseUrl()).toBe(`${base}/owned-token`);
    await expect(resolveBaseUrl({})).rejects.toThrow("pass --base-url or --state-file");
    await expect(resolveBaseUrl({}, join(root, "missing"))).rejects.toThrow();
    await writeFile(stateFile, "{invalid");
    await expect(resolveBaseUrl({}, stateFile)).rejects.toThrow();
    expect(await readFile(stateFile, "utf8")).toBe("{invalid");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});

test("Boss repair consumes HTTP responses and sends only the requested repoint target", async () => {
  const requests: Array<{ path: string; method: string; type: string | null; body: string }> = [];
  let status = 200;
  let body: unknown = { pointer: null, candidates: [] };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      requests.push({
        path: new URL(request.url).pathname,
        method: request.method,
        type: request.headers.get("content-type"),
        body: await request.text(),
      });
      return Response.json(body, { status });
    },
  });
  const target = { agent: "example-boss", sessionId: "saved-session" };
  const base = `http://127.0.0.1:${server.port}/owned-token`;
  try {
    expect(await runBossRepair("list", base, target)).toEqual({ status, body });
    body = { ok: true, pointer: { version: 1, ...target } };
    expect(await runBossRepair("repoint", base, target)).toEqual({ status, body });
    status = 400;
    body = { ok: false, error: "no persisted Boss session example-boss/missing" };
    expect(await runBossRepair("repoint", base, { ...target, sessionId: "missing" })).toEqual({ status, body });
    expect(requests).toEqual([
      { path: "/owned-token/api/boss", method: "GET", type: null, body: "" },
      { path: "/owned-token/api/boss/repoint", method: "POST", type: "application/json", body: JSON.stringify(target) },
      { path: "/owned-token/api/boss/repoint", method: "POST", type: "application/json", body: JSON.stringify({ ...target, sessionId: "missing" }) },
    ]);
    await expect(runBossRepair("repoint", base, { ...target, agent: "" })).rejects.toThrow("requires --agent and --session");
    await expect(runBossRepair("repoint", base, { ...target, sessionId: "" })).rejects.toThrow("requires --agent and --session");
    await expect(runBossRepair("reset", base, target)).rejects.toThrow("unknown command: reset");
    expect(requests).toHaveLength(3);
  } finally {
    server.stop(true);
  }
});
