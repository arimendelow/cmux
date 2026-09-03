import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PlanBlock } from "../src/components/Transcript";

test("plan card renders every structured step and status", () => {
  const html = renderToStaticMarkup(
    <PlanBlock
      block={{
        kind: "plan",
        entries: [
          { content: "Inspect the greeting", status: "completed" },
          { content: "Update the message", status: "in_progress" },
          { content: "Run the check", status: "pending" },
        ],
      }}
    />,
  );

  expect(html).toContain("Inspect the greeting");
  expect(html).toContain("Update the message");
  expect(html).toContain("Run the check");
  expect(html).toContain("data-plan-status=\"in_progress\"");
});
