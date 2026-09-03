import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PermissionBlock } from "../src/components/Transcript";

test("permission card renders the operation and all decisions", () => {
  const html = renderToStaticMarkup(
    <PermissionBlock
      block={{
        kind: "permission",
        requestId: "99",
        title: "Read greeting.mjs",
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
        ],
        status: "pending",
      }}
      onRespond={() => {}}
    />,
  );

  expect(html).toContain("Read greeting.mjs");
  expect(html).toContain("Allow once");
  expect(html).toContain("Reject");
  expect(html).toContain("data-permission-status=\"pending\"");
});
