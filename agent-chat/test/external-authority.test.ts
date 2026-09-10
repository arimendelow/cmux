import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readLines } from "../adapters/lines";
import { WorkbenchHeader } from "../src/components/WorkbenchHeader";
import { forbiddenPublicPattern } from "./forbidden-terms";
import {
  externalAuthorityForTest,
  externalAuthorityStatusForTest,
  externalAuthorityStatusFromOutputForTest,
  providerDefinitionsForTest,
  workbenchExperienceForTest,
} from "../server";

const scratchRoot = join(import.meta.dir, ".scratch");

test("Workbench ships neutral external-authority defaults with no product-specific vocabulary", () => {
  expect(workbenchExperienceForTest("ouro-workbench-v1", "Desk / demo-task")).toEqual({
    productName: "Ouro Workbench v1",
    surfaceName: "Boss",
    contextLabel: "Desk / demo-task",
    defaultProvider: "ouro-boss",
    localAuthorityLabel: "Controlled here",
    externalAuthority: {
      label: "Controlled elsewhere",
      status: "unknown",
    },
  });
  expect(workbenchExperienceForTest("", "Desk / demo-task")).toBeUndefined();
});

test("the host injects the external-authority label, open URL, and open label", () => {
  expect(externalAuthorityForTest({
    label: "  Example Control Plane  ",
    url: "https://example.invalid/control",
    openLabel: "Open control plane",
    status: "connected",
  })).toEqual({
    label: "Example Control Plane",
    openUrl: "https://example.invalid/control",
    openLabel: "Open control plane",
    status: "connected",
  });

  expect(externalAuthorityForTest({ label: "", url: "", openLabel: "", status: "unknown" })).toEqual({
    label: "Controlled elsewhere",
    status: "unknown",
  });

  expect(externalAuthorityForTest({
    label: "Example",
    url: "javascript:alert(1)",
    status: "unknown",
  })).toEqual({
    label: "Example",
    status: "unknown",
  });

  expect(externalAuthorityForTest({
    label: "Example",
    url: "http://127.0.0.1:9000/control",
    status: "unknown",
  })).toEqual({
    label: "Example",
    openUrl: "http://127.0.0.1:9000/control",
    status: "unknown",
  });
});

test("external-authority status parsing is generic and fails closed", () => {
  expect(externalAuthorityStatusFromOutputForTest("Status: connected\n", 0)).toBe("connected");
  expect(externalAuthorityStatusFromOutputForTest("status: DISCONNECTED\n", 0)).toBe("disconnected");
  expect(externalAuthorityStatusFromOutputForTest("Status: stopped\n", 0)).toBe("stopped");
  expect(externalAuthorityStatusFromOutputForTest("Status: something-else\n", 0)).toBe("unknown");
  expect(externalAuthorityStatusFromOutputForTest("no status line\n", 0)).toBe("unknown");
  expect(externalAuthorityStatusFromOutputForTest("", 1)).toBe("unavailable");
});

test("a missing or hanging external-authority status helper stays bounded", async () => {
  await mkdir(scratchRoot, { recursive: true });
  const root = await mkdtemp(join(scratchRoot, "external-authority-"));
  try {
    expect(await externalAuthorityStatusForTest(["/definitely/missing-helper"], 20, 20)).toBe("unavailable");
    const helper = join(root, "helper.sh");
    await Bun.write(helper, "#!/bin/sh\nwhile :; do sleep 1; done\n");
    await chmod(helper, 0o755);
    expect(await externalAuthorityStatusForTest([helper], 200, 50)).toBe("unavailable");
    expect(await externalAuthorityStatusForTest([], 200, 50)).toBe("unknown");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stock Agent Chat providers carry no private launcher, plugin alias, or wrapper", () => {
  const providers = providerDefinitionsForTest();
  expect(providers.map((provider) => provider.id)).toEqual([
    "copilot",
    "claude",
    "codex",
    "opencode",
    "pi",
    "gemini",
  ]);
  const copilot = providers.find((provider) => provider.id === "copilot");
  expect(copilot?.label).toBe("GitHub Copilot");
  expect(copilot?.cmd).toEqual(["copilot", "--acp", "--stdio"]);
  expect(JSON.stringify(providers)).not.toMatch(forbiddenPublicPattern);
});

function installedConfig(argv: string[]) {
  return {
    schemaVersion: 1,
    owner: "example-integration",
    pluginVersion: "1.0.0",
    displayLabel: "Example Controller",
    openUrl: "https://example.invalid/control",
    statusCommand: { argv, timeoutMs: 2_000, maxOutputBytes: 4_096 },
  };
}

// Exercise the actual sidecar startup and its renderer-facing hello, not a mocked config reader.
async function withAuthorityServer(
  options: {
    config?: (argv: string[]) => unknown;
    output?: string;
    script?: string;
    environment?: (argv: string[]) => Record<string, string>;
  },
  check: (fixture: { hello: any; root: string; diagnostics(): string }) => Promise<void>,
) {
  await mkdir(scratchRoot, { recursive: true });
  const root = await mkdtemp(join(scratchRoot, "authority-startup-"));
  const support = join(root, "Application Support", "Example Workbench");
  const configFile = join(support, "integrations", "external-authority.json");
  const stateFile = join(root, "server.json");
  const helper = join(root, "status helper.mjs");
  const argv = [process.execPath, helper];
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let socket: WebSocket | undefined;
  let diagnostics = "";
  let stderr: Promise<unknown> | undefined;
  let serialized: string | undefined;
  try {
    await mkdir(join(root, "home"), { recursive: true });
    await Bun.write(helper, [
      'import { writeFileSync } from "node:fs";',
      'writeFileSync(new URL("./invocation.json", import.meta.url), JSON.stringify({ argv: process.argv.slice(2), pid: process.pid }));',
      options.script ?? `process.stdout.write(${JSON.stringify(options.output ?? '{"schemaVersion":1,"state":"active"}\n')});`,
    ].join("\n"));
    if (options.config) {
      const config = options.config(argv);
      serialized = typeof config === "string" ? config : JSON.stringify(config);
      await mkdir(join(support, "integrations"), { recursive: true });
      await Bun.write(configFile, serialized);
    }
    child = Bun.spawn([process.execPath, "server.ts"], {
      cwd: join(import.meta.dir, ".."),
      stdout: "ignore",
      stderr: "pipe",
      env: {
        HOME: join(root, "home"),
        XDG_CONFIG_HOME: join(root, "home", ".config"),
        PATH: "/usr/bin:/bin",
        CMUX_AGENT_CHAT_PORT: "0",
        CMUX_AGENT_CHAT_STATE_FILE: stateFile,
        CMUX_AGENT_CHAT_TOKEN: "authority-token",
        CMUX_AGENT_CHAT_PRODUCT: "ouro-workbench-v1",
        CMUX_AGENT_CHAT_APP_SUPPORT_ROOT: support,
        CMUX_AGENT_CHAT_SESSION_DIR: join(root, "sessions"),
        CMUX_AGENT_CHAT_ALLOWED_ROOTS: root,
        CMUX_AGENT_UI_CWD: root,
        CMUX_AGENT_MODELS_URL: "http://127.0.0.1:1",
        ...options.environment?.(argv),
      },
    });
    stderr = readLines(child.stderr as ReadableStream<Uint8Array>, (line) => { diagnostics += `${line}\n`; });
    let port: number | undefined;
    const deadline = Date.now() + 10_000;
    while (!port && Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`sidecar exited: ${diagnostics}`);
      try { port = JSON.parse(await readFile(stateFile, "utf8")).port; } catch {}
      if (!port) await Bun.sleep(20);
    }
    if (!port) throw new Error(`sidecar startup timed out: ${diagnostics}`);
    const hello = await new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("hello timed out")), 5_000);
      socket = new WebSocket(`ws://127.0.0.1:${port}/authority-token/ws`);
      socket.onmessage = (event) => {
        const message = JSON.parse(String(event.data));
        if (message.kind === "hello") {
          clearTimeout(timeout);
          resolve(message);
        }
      };
      socket.onerror = () => {
        clearTimeout(timeout);
        reject(new Error("sidecar WebSocket failed"));
      };
    });
    await check({ hello, root, diagnostics: () => diagnostics });
    if (serialized !== undefined) expect(await readFile(configFile, "utf8")).toBe(serialized);
  } finally {
    socket?.close();
    if (child) {
      child.kill("SIGKILL");
      await child.exited;
      await stderr;
    }
    await rm(root, { recursive: true, force: true });
  }
}

test("missing installed config preserves the neutral startup route", async () => {
  await withAuthorityServer({}, async ({ hello, root }) => {
    expect(hello.experience.externalAuthority).toEqual({ label: "Controlled elsewhere", status: "unknown" });
    expect(await Bun.file(join(root, "invocation.json")).exists()).toBe(false);
  });
});

test("missing installed config preserves environment presentation and the legacy text helper", async () => {
  await withAuthorityServer({
    output: "Status: connected\n",
    environment: (argv) => ({
      CMUX_AGENT_CHAT_EXTERNAL_AUTHORITY_LABEL: "Environment Controller",
      CMUX_AGENT_CHAT_EXTERNAL_AUTHORITY_URL: "http://127.0.0.1:9000/control",
      CMUX_AGENT_CHAT_EXTERNAL_AUTHORITY_OPEN_LABEL: "Open controller",
      CMUX_AGENT_CHAT_EXTERNAL_AUTHORITY_STATUS_COMMAND: JSON.stringify(argv),
    }),
  }, async ({ hello, root }) => {
    expect(hello.experience.externalAuthority).toEqual({
      label: "Environment Controller",
      openUrl: "http://127.0.0.1:9000/control",
      openLabel: "Open controller",
      status: "connected",
    });
    expect(JSON.parse(await readFile(join(root, "invocation.json"), "utf8")).argv).toEqual([]);
  });
});

test("non-Workbench startup ignores installed presentation and never invokes its helper", async () => {
  await withAuthorityServer({
    config: installedConfig,
    environment: () => ({ CMUX_AGENT_CHAT_PRODUCT: "" }),
  }, async ({ hello, root }) => {
    expect(hello.experience).toBeUndefined();
    expect(await Bun.file(join(root, "invocation.json")).exists()).toBe(false);
  });
});

test.each([
  ["active", "connected", "Connected"],
  ["inactive", "disconnected", "Disconnected"],
  ["unknown", "unknown", "Status unknown"],
])("installed JSON state %s reaches the real header as %s", async (state, status, statusLabel) => {
  await withAuthorityServer({
    config: installedConfig,
    output: JSON.stringify({
      schemaVersion: 1, state, label: "Ignored helper label", detail: "Example observation",
      checkedAt: "2026-09-10T00:00:00.000Z", authority: "local", approved: true,
    }),
    environment: () => ({
      CMUX_AGENT_CHAT_EXTERNAL_AUTHORITY_LABEL: "Ignored environment label",
      CMUX_AGENT_CHAT_EXTERNAL_AUTHORITY_URL: "https://ignored.invalid/",
      CMUX_AGENT_CHAT_EXTERNAL_AUTHORITY_OPEN_LABEL: "Ignored open label",
      CMUX_AGENT_CHAT_EXTERNAL_AUTHORITY_STATUS_COMMAND: "/not/a/real/helper",
    }),
  }, async ({ hello, root }) => {
    expect(hello.experience.externalAuthority).toEqual({
      label: "Example Controller",
      openUrl: "https://example.invalid/control",
      status,
    });
    expect(JSON.parse(await readFile(join(root, "invocation.json"), "utf8")).argv)
      .toEqual(["--session-id", "", "--authority", "unknown"]);
    const html = renderToStaticMarkup(createElement(WorkbenchHeader, { experience: hello.experience }));
    expect(html).toContain("Example Controller");
    expect(html).toContain('href="https://example.invalid/control"');
    expect(html).toContain(statusLabel);
    expect(html).not.toContain("Ignored");
    expect(hello.boss.status).toBe("none");
    expect(hello.experience.localAuthorityLabel).toBe("Controlled here");
  });
});

test.each([
  ["malformed JSON", () => "{"],
  ["null", () => null],
  ["array", () => []],
  ["unsupported schema", (argv) => ({ ...installedConfig(argv), schemaVersion: 2 })],
  ["missing owner", (argv) => ({ ...installedConfig(argv), owner: undefined })],
  ["blank owner", (argv) => ({ ...installedConfig(argv), owner: " " })],
  ["invalid optional version", (argv) => ({ ...installedConfig(argv), pluginVersion: 1 })],
  ["blank label", (argv) => ({ ...installedConfig(argv), displayLabel: " " })],
  ["oversized label", (argv) => ({ ...installedConfig(argv), displayLabel: "x".repeat(65) })],
  ["non-string label", (argv) => ({ ...installedConfig(argv), displayLabel: {} })],
  ["unsafe URL", (argv) => ({ ...installedConfig(argv), openUrl: "javascript:alert(1)" })],
  ["insecure installed URL", (argv) => ({ ...installedConfig(argv), openUrl: "http://example.invalid/" })],
  ["malformed URL", (argv) => ({ ...installedConfig(argv), openUrl: "https://" })],
  ["URL credentials", (argv) => ({ ...installedConfig(argv), openUrl: "https://user:secret@example.invalid/" })],
  ["unexpected authority", (argv) => ({ ...installedConfig(argv), authority: "local" })],
  ["missing command", (argv) => ({ ...installedConfig(argv), statusCommand: undefined })],
  ["empty argv", (argv) => ({ ...installedConfig(argv), statusCommand: { argv: [], timeoutMs: 100 } })],
  ["relative executable", (argv) => ({ ...installedConfig(argv), statusCommand: { argv: ["bun", argv[1]], timeoutMs: 100 } })],
  ["relative helper", (argv) => ({ ...installedConfig(argv), statusCommand: { argv: [argv[0], "helper.mjs"], timeoutMs: 100 } })],
  ["null byte", (argv) => ({ ...installedConfig(argv), statusCommand: { argv: [argv[0], "/bad\0path"], timeoutMs: 100 } })],
  ["string command", (argv) => ({ ...installedConfig(argv), statusCommand: { argv: argv.join(" "), timeoutMs: 100 } })],
  ["missing timeout", (argv) => ({ ...installedConfig(argv), statusCommand: { argv } })],
  ["short timeout", (argv) => ({ ...installedConfig(argv), statusCommand: { argv, timeoutMs: 99 } })],
  ["long timeout", (argv) => ({ ...installedConfig(argv), statusCommand: { argv, timeoutMs: 5_001 } })],
  ["fractional timeout", (argv) => ({ ...installedConfig(argv), statusCommand: { argv, timeoutMs: 100.5 } })],
  ["string timeout", (argv) => ({ ...installedConfig(argv), statusCommand: { argv, timeoutMs: "100" } })],
  ["small output limit", (argv) => ({ ...installedConfig(argv), statusCommand: { argv, timeoutMs: 100, maxOutputBytes: 255 } })],
  ["large output limit", (argv) => ({ ...installedConfig(argv), statusCommand: { argv, timeoutMs: 100, maxOutputBytes: 8_193 } })],
  ["unknown command field", (argv) => ({ ...installedConfig(argv), statusCommand: { argv, timeoutMs: 100, shell: true } })],
  ["oversized config", (argv) => ({ ...installedConfig(argv), owner: "x".repeat(65_537) })],
] satisfies [string, (argv: string[]) => unknown][])("invalid installed config (%s) fails visibly without running or falling back to environment", async (_name, config) => {
  await withAuthorityServer({
    config,
    environment: () => ({
      CMUX_AGENT_CHAT_EXTERNAL_AUTHORITY_LABEL: "Must not hide invalid config",
      CMUX_AGENT_CHAT_EXTERNAL_AUTHORITY_URL: "https://ignored.invalid/",
    }),
  }, async ({ hello, root, diagnostics }) => {
    expect(hello.experience.externalAuthority).toEqual({ label: "Controlled elsewhere", status: "unavailable" });
    expect(await Bun.file(join(root, "invocation.json")).exists()).toBe(false);
    expect(diagnostics()).toContain("external-authority");
  });
});

test.each([
  "Status: connected\n",
  "not JSON",
  "null",
  "[]",
  "{}",
  '{"state":"local"}',
  '{"state":true}',
  '{"state":"active","schemaVersion":2}',
  '{"state":"active","label":{}}',
  '{"state":"active","detail":[]}',
  '{"state":"active","checkedAt":"not-a-date"}',
])("invalid installed helper output (%s) renders neutral unavailable", async (output) => {
  await withAuthorityServer({ config: installedConfig, output }, async ({ hello }) => {
    expect(hello.experience.externalAuthority).toEqual({ label: "Controlled elsewhere", status: "unavailable" });
  });
});

test.each([
  ["nonzero exit", 'process.stdout.write(\'{"state":"active"}\'); process.exit(1);'],
  ["invalid UTF-8", 'process.stdout.write(Buffer.concat([Buffer.from(\'{"state":"active","detail":"\'), Buffer.from([0xff]), Buffer.from(\'"}\')]));'],
  ["timeout", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1_000);'],
  ["overflow then hang", 'process.stdout.write(\'{"state":"active"}\' + " ".repeat(8_193)); setInterval(() => {}, 1_000);'],
])("installed helper failure (%s) is bounded and leaves no live helper", async (_name, script) => {
  await withAuthorityServer({
    config: (argv) => ({ ...installedConfig(argv), statusCommand: { argv, timeoutMs: 100 } }),
    script,
  }, async ({ hello, root }) => {
    expect(hello.experience.externalAuthority).toEqual({ label: "Controlled elsewhere", status: "unavailable" });
    const { pid } = JSON.parse(await readFile(join(root, "invocation.json"), "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  });
});

test("a missing installed helper renders neutral unavailable", async () => {
  await withAuthorityServer({
    config: () => installedConfig(["/not/a/real/status-helper"]),
  }, async ({ hello }) => {
    expect(hello.experience.externalAuthority).toEqual({ label: "Controlled elsewhere", status: "unavailable" });
  });
});

test.each([256, 257])("installed status output respects its %i-byte boundary without accepting a valid prefix", async (bytes) => {
  const json = '{"state":"active","detail":"é"}';
  await withAuthorityServer({
    config: (argv) => ({
      ...installedConfig(argv), statusCommand: { argv, timeoutMs: 2_000, maxOutputBytes: 256 },
    }),
    output: json + " ".repeat(bytes - Buffer.byteLength(json)),
  }, async ({ hello }) => {
    expect(hello.experience.externalAuthority).toEqual(bytes === 256 ? {
      label: "Example Controller", openUrl: "https://example.invalid/control", status: "connected",
    } : { label: "Controlled elsewhere", status: "unavailable" });
  });
});
