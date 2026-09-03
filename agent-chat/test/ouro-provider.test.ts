import { expect, test } from "bun:test";
import { providerDefinitionsForProductForTest, providerDefinitionsForTest, resolveSessionStartForTest, workbenchExperienceForTest } from "../server";

test("Workbench v1 exposes direct Copilot and scoped Agency worker profiles", () => {
  const providers = providerDefinitionsForTest();
  const copilot = providers.find((provider) => provider.id === "copilot");
  const worker = providers.find((provider) => provider.id === "agency-worker");

  expect(copilot?.label).toBe("GitHub Copilot");
  expect(copilot?.cmd).toEqual([
    "agency",
    "copilot",
    "--no-config-plugins",
    "--no-default-mcps",
    "--no-aec",
    "--acp",
    "--stdio",
  ]);
  expect(worker?.label).toBe("Agency worker");
  expect(worker?.role).toBe("boss");
  expect(worker?.description).toBe("Desk-aware Workbench boss");
  expect(worker?.cmd).toEqual([
    "agency",
    "copilot",
    "--no-config-plugins",
    "--no-default-mcps",
    "--no-aec",
    "--plugin",
    "github:shared-internal-tools/ms-desk:plugins/ms-desk",
    "-a",
    "ms-desk:worker",
    "--acp",
    "--stdio",
  ]);
  expect(worker?.startupTimeoutMs).toBe(90_000);
  expect(worker?.probeCatalogs).toBe(false);
  expect(worker?.defaultAutoApprove).toBe(false);
});

test("Workbench v1 advertises its boss-first authority contract", () => {
  expect(workbenchExperienceForTest("ouro-workbench-v1", "Desk / demo-task")).toEqual({
    productName: "Ouro Workbench v1",
    surfaceName: "Boss",
    contextLabel: "Desk / demo-task",
    defaultProvider: "agency-worker",
    localAuthorityLabel: "Controlled here",
    hubAuthorityLabel: "Controlled in Agency Hub",
  });
  expect(workbenchExperienceForTest("", "Desk / demo-task")).toBeUndefined();
  expect(providerDefinitionsForProductForTest("ouro-workbench-v1").map((provider) => provider.id)).toEqual([
    "agency-worker",
    "copilot",
  ]);
});

test("session start defaults are safe and do not retain prompt text", () => {
  expect(resolveSessionStartForTest("agency-worker", "secret customer prompt", undefined)).toEqual({
    title: "Agency worker",
    autoApprove: false,
  });
  expect(resolveSessionStartForTest("agency-worker", "secret customer prompt", true)).toEqual({
    title: "Agency worker",
    autoApprove: true,
  });
});
