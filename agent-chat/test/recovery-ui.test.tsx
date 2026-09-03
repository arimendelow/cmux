import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RecoveryBanner } from "../src/components/RecoveryBanner";

test("recovery banner states the verified resume outcome", () => {
  const html = renderToStaticMarkup(
    <RecoveryBanner
      recovery={{
        mode: "resumed",
        title: "Conversation resumed",
        message: "Loaded the existing provider session after Workbench restarted.",
      }}
    />,
  );

  expect(html).toContain("Conversation resumed");
  expect(html).toContain("Loaded the existing provider session after Workbench restarted.");
  expect(html).toContain("data-recovery-mode=\"resumed\"");
});
