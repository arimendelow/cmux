import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { shouldShowProviderPicker } from "../src/components/Composer";
import { WorkbenchHeader } from "../src/components/WorkbenchHeader";

test("Workbench header makes local and Hub authority explicit", () => {
  const html = renderToStaticMarkup(
    <WorkbenchHeader
      experience={{
        productName: "Ouro Workbench v1",
        surfaceName: "Boss",
        contextLabel: "Desk / demo-task",
        defaultProvider: "ouro-boss",
        localAuthorityLabel: "Controlled here",
        hubAuthorityLabel: "Controlled in Agency Hub",
        hubUrl: "https://aka.ms/agency/hub",
        hubStatus: "connected",
      }}
    />,
  );

  expect(html).toContain("Ouro Workbench v1");
  expect(html).toContain("Boss");
  expect(html).toContain("Desk / demo-task");
  expect(html).toContain("Controlled here");
  expect(html).toContain("Remote sessions");
  expect(html).toContain("Controlled in Agency Hub");
  expect(html).toContain("Hub connected");
  expect(html).toContain("href=\"https://aka.ms/agency/hub\"");
  expect(html).toContain("Open Hub");
  expect(shouldShowProviderPicker(null)).toBe(true);
  expect(shouldShowProviderPicker({ productName: "Ouro Workbench v1" })).toBe(false);
});

test("Workbench authority stays readable in a narrow pane", () => {
  const css = readFileSync(join(import.meta.dir, "../public/app.css"), "utf8");
  expect(css).toContain("@media (max-width: 420px)");
  expect(css).toContain(".authority-remote { flex-direction: column; align-items: flex-start; gap: 2px; }");
  expect(css).toContain(".authority-hub > span:first-child { flex-basis: 100%; }");
});
