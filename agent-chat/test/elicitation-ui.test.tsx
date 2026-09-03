import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ElicitationBlock } from "../src/components/Transcript";

test("elicitation card renders fields and explicit outcomes", () => {
  const html = renderToStaticMarkup(
    <ElicitationBlock
      block={{
        kind: "elicitation",
        requestId: "100",
        message: "How should I update the greeting?",
        fields: [
          {
            name: "strategy",
            type: "string",
            title: "Strategy",
            required: true,
            options: ["conservative", "balanced"],
            defaultValue: "balanced",
          },
          {
            name: "includeCheck",
            type: "boolean",
            title: "Run the check",
            required: false,
            defaultValue: true,
          },
        ],
        status: "pending",
      }}
      onRespond={() => {}}
    />,
  );

  expect(html).toContain("How should I update the greeting?");
  expect(html).toContain("Strategy");
  expect(html).toContain("Run the check");
  expect(html).toContain("Submit");
  expect(html).toContain("Decline");
  expect(html).toContain("Cancel");
  expect(html).toContain("data-elicitation-status=\"pending\"");
});
