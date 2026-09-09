import { expect, test } from "bun:test";
import { providerDefinitionsForProductForTest, resolveSessionStartForProductForTest, resolveSessionStartForTest, startErrorMessageForTest, workbenchExperienceForTest } from "../server";

test("Workbench v1 exposes exactly one selected Ouro Boss", () => {
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
  expect(providerDefinitionsForProductForTest("ouro-workbench-v1", {
    bossAgent: "slugger",
    ouroCommand: "/usr/local/bin/ouro",
    workbenchMcp: "/Applications/Ouro Workbench.app/Contents/MacOS/OuroWorkbenchMCP",
  })).toEqual([expect.objectContaining({
    id: "ouro-boss",
    label: "slugger",
    description: "Selected Ouro Boss",
    role: "boss",
    adapter: "acp",
    cmd: [
      "/usr/local/bin/ouro",
      "acp-serve",
      "--agent",
      "slugger",
      "--workbench-mcp",
      "/Applications/Ouro Workbench.app/Contents/MacOS/OuroWorkbenchMCP",
    ],
    defaultAutoApprove: false,
    probeCatalogs: false,
  })]);
  expect(providerDefinitionsForProductForTest("ouro-workbench-v1", {
    bossError: "Choose one enabled Ouro agent as Boss.",
  })).toEqual([expect.objectContaining({
    id: "ouro-boss",
    description: "Choose one enabled Ouro agent as Boss.",
    unavailableReason: "Choose one enabled Ouro agent as Boss.",
  })]);
  expect(providerDefinitionsForProductForTest("ouro-workbench-v1", {
    bossAgent: "slugger",
    ouroCommand: "/usr/local/bin/ouro",
  })[0]?.cmd).toEqual([
    "/usr/local/bin/ouro",
    "acp-serve",
    "--agent",
    "slugger",
  ]);
  expect(startErrorMessageForTest(
    "ouro-boss",
    new Error("working directory is outside configured roots"),
    "ouro-workbench-v1",
  )).toBe("Failed to start Boss: working directory is outside the configured roots");
});

test("session start defaults are safe and do not retain prompt text", () => {
  expect(resolveSessionStartForProductForTest("ouro-workbench-v1", "ouro-boss", undefined, {
    bossAgent: "slugger",
  })).toEqual({
    title: "Boss",
    autoApprove: false,
  });
  expect(resolveSessionStartForProductForTest("ouro-workbench-v1", "ouro-boss", true, {
    bossAgent: "slugger",
  })).toEqual({
    title: "Boss",
    autoApprove: true,
  });
  expect(() => resolveSessionStartForProductForTest("ouro-workbench-v1", "ouro-boss", undefined, {
    bossError: "Choose one enabled Ouro agent as Boss.",
  })).toThrow("Choose one enabled Ouro agent as Boss.");
  expect(resolveSessionStartForTest("copilot", "secret customer prompt", undefined)).toEqual({
    title: "GitHub Copilot",
    autoApprove: false,
  });
});
