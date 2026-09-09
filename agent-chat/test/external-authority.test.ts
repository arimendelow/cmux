import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
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
