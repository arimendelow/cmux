import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as recovery from "../src/components/RecoveryBanner";

function render(assessment: string, locale = "en", error?: string) {
  return renderToStaticMarkup(createElement((recovery as any).WorkbenchRestoreBanner, {
    receipt: { kind: "workbench-restore", facts: null, unresolved: [], assessment, error },
    locale,
  }));
}

test("the native receipt distinguishes clean restore, pending assessment, and unsettled cancellation", () => {
  expect(render("none")).toContain("No recovery assessment was needed.");
  expect(render("pending")).toContain("Your input takes priority.");
  expect(render("cancelling")).toContain("Waiting for cancellation to settle.");
  expect(render("cancelled")).toContain("Restore facts are retained.");
  expect(render("failed", "en", "native-unavailable")).toContain("Native restore facts are unavailable.");
  expect(render("failed", "en", "cancel-failed")).toContain("Your turn has not started.");
  expect(render("running")).toContain('role="status"');
});

test("native recovery states are localized for Japanese without changing the underlying facts", () => {
  for (const state of ["none", "waiting", "pending", "running", "cancelling", "cancelled", "completed", "failed"]) {
    const html = render(state, "ja-JP");
    expect(html).toContain("起動時の復元");
    expect(html).not.toContain("undefined");
    expect(html).not.toContain("Native restore");
  }
});
