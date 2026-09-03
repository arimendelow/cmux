import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkbenchHeader } from "../src/components/WorkbenchHeader";

test("Workbench header makes local and Hub authority explicit", () => {
  const html = renderToStaticMarkup(
    <WorkbenchHeader
      experience={{
        productName: "Ouro Workbench v1",
        surfaceName: "Boss",
        contextLabel: "Desk / demo-task",
        defaultProvider: "agency-worker",
        localAuthorityLabel: "Controlled here",
        hubAuthorityLabel: "Controlled in Agency Hub",
      }}
    />,
  );

  expect(html).toContain("Ouro Workbench v1");
  expect(html).toContain("Boss");
  expect(html).toContain("Desk / demo-task");
  expect(html).toContain("Controlled here");
  expect(html).toContain("Remote sessions");
  expect(html).toContain("Controlled in Agency Hub");
});
