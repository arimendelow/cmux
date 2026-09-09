import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { shouldShowProviderPicker } from "../src/components/Composer";
import { providerInfoForStatusRow } from "../src/components/StatusRow";
import { WorkbenchHeader } from "../src/components/WorkbenchHeader";

test("Workbench header makes local and external authority explicit", () => {
  const html = renderToStaticMarkup(
    <WorkbenchHeader
      experience={{
        productName: "Ouro Workbench v1",
        surfaceName: "Boss",
        contextLabel: "Desk / demo-task",
        defaultProvider: "ouro-boss",
        localAuthorityLabel: "Controlled here",
        externalAuthority: {
          label: "Example Control Plane",
          openUrl: "https://example.invalid/control",
          openLabel: "Open control plane",
          status: "connected",
        },
      }}
    />,
  );

  expect(html).toContain("Ouro Workbench v1");
  expect(html).toContain("Boss");
  expect(html).toContain("Desk / demo-task");
  expect(html).toContain("Controlled here");
  expect(html).toContain("Remote sessions");
  expect(html).toContain("Example Control Plane");
  expect(html).toContain("Connected");
  expect(html).toContain("href=\"https://example.invalid/control\"");
  expect(html).toContain("Open control plane");
  expect(shouldShowProviderPicker(null)).toBe(true);
  expect(shouldShowProviderPicker({ productName: "Ouro Workbench v1" })).toBe(false);
});

test("Workbench authority stays readable in a narrow pane", () => {
  const css = readFileSync(join(import.meta.dir, "../public/app.css"), "utf8");
  expect(css).toContain("@media (max-width: 420px)");
  expect(css).toContain(".authority-remote { flex-direction: column; align-items: flex-start; gap: 2px; }");
  expect(css).toContain(".authority-external > span:first-child { flex-basis: 100%; }");
});

test("Workbench composer shows the selected Boss name instead of its internal provider id", () => {
  const composerSource = readFileSync(join(import.meta.dir, "../src/components/Composer.tsx"), "utf8");
  const provider = providerInfoForStatusRow(
    "ouro-boss",
    [{ id: "ouro-boss", label: "ouroboros", role: "boss", installed: true }],
  );

  expect(composerSource).toContain("providers={providers}");
  expect(provider.label).toBe("ouroboros");
});


test("Workbench header falls back to a neutral external authority with no link", () => {
  const html = renderToStaticMarkup(
    <WorkbenchHeader
      experience={{
        productName: "Ouro Workbench v1",
        surfaceName: "Boss",
        defaultProvider: "ouro-boss",
        localAuthorityLabel: "Controlled here",
        externalAuthority: { label: "Controlled elsewhere", status: "unknown" },
      }}
    />,
  );

  expect(html).toContain("Controlled elsewhere");
  expect(html).toContain("Status unknown");
  expect(html).not.toContain("<a ");
});

test("Workbench names the Boss surface as app-wide in its header", () => {
  const html = renderToStaticMarkup(
    <WorkbenchHeader
      experience={{
        productName: "Ouro Workbench v1",
        surfaceName: "Boss",
        defaultProvider: "ouro-boss",
        localAuthorityLabel: "Controlled here",
        externalAuthority: { label: "Controlled elsewhere", status: "unknown" },
      }}
    />,
  );

  expect(html).toContain("App-wide");
});
