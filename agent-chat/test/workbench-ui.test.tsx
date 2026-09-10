import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import {
  clearAcknowledgedDraft,
  providerSwitchAttachmentState,
} from "../src/components/Chat";
import {
  shouldInvalidateImagesForProviderSwitch,
  shouldShowProviderPicker,
} from "../src/components/Composer";
import { imageAttachmentAllowed } from "../src/session";
import { providerInfoForStatusRow } from "../src/components/StatusRow";
import { WorkbenchHeader } from "../src/components/WorkbenchHeader";
import { ImageAttachmentTray } from "../src/components/ImageAttachments";

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

test("Workbench image tray shows a removable preview and the composer owns file drops", () => {
  const html = renderToStaticMarkup(
    <ImageAttachmentTray
      enabled
      error=""
      attachments={[{
        id: "image-1",
        name: "screenshot.png",
        mimeType: "image/png",
        data: "cG5n",
        byteCount: 3,
      }]}
      onAdd={() => {}}
      onRemove={() => {}}
    />,
  );
  const composerSource = readFileSync(join(import.meta.dir, "../src/components/Composer.tsx"), "utf8");
  const chatSource = readFileSync(join(import.meta.dir, "../src/components/Chat.tsx"), "utf8");
  const attachmentSource = readFileSync(join(import.meta.dir, "../src/components/ImageAttachments.tsx"), "utf8");
  const sessionSource = readFileSync(join(import.meta.dir, "../src/session.ts"), "utf8");
  const serverSource = readFileSync(join(import.meta.dir, "../server.ts"), "utf8");
  const css = readFileSync(join(import.meta.dir, "../public/app.css"), "utf8");

  expect(html).toContain("data:image/png;base64,cG5n");
  expect(html).toContain("Remove screenshot.png");
  expect(html).toContain("+ Image");
  expect(composerSource).toContain("{...imageAttachments.dropHandlers}");
  expect(chatSource).toContain("{...imageAttachments.dropHandlers}");
  expect(attachmentSource).toContain("imageFileInteraction(enabled");
  expect(attachmentSource).toContain('window.addEventListener("dragover"');
  expect(attachmentSource).toContain('window.addEventListener("drop"');
  expect(sessionSource).toContain("setComposerAttachments(pending.attachments ?? [])");
  expect(sessionSource).toContain('settlePendingReply(pendingRepliesRef.current, requestId, false)');
  expect(serverSource).toContain('kind: "send-accepted"');
  expect(serverSource).toContain('kind: "history"');
  expect(css).toContain(".image-drop-active");
});

test("Workbench reports rejected image drops without exposing an unusable picker", () => {
  const html = renderToStaticMarkup(
    <ImageAttachmentTray
      enabled={false}
      error="This provider does not support image attachments."
      attachments={[]}
      onAdd={() => {}}
      onRemove={() => {}}
    />,
  );

  expect(html).toContain("This provider does not support image attachments.");
  expect(html).not.toContain("+ Image");
});

test("switching to a text-only provider clears staged images", () => {
  expect(shouldInvalidateImagesForProviderSwitch("acp-a", "acp-b")).toBe(true);
  expect(shouldInvalidateImagesForProviderSwitch("acp-a", "acp-a")).toBe(false);
  expect(shouldInvalidateImagesForProviderSwitch("", "acp-a")).toBe(false);
});

test("admission locks options but leaves the Stop action outside the inert subtree", () => {
  const source = readFileSync(join(import.meta.dir, "../src/components/StatusRow.tsx"), "utf8");
  const controlsStart = source.indexOf('className="status-row-controls"');
  const controlsEnd = source.indexOf('<div className="status-row-spacer"', controlsStart);
  const trailing = source.indexOf("{trailing}", controlsEnd);

  expect(controlsStart).toBeGreaterThan(-1);
  expect(controlsEnd).toBeGreaterThan(controlsStart);
  expect(trailing).toBeGreaterThan(controlsEnd);
});

test("an acknowledgment clears only the draft snapshot that was submitted", () => {
  expect(clearAcknowledgedDraft("sent", "sent")).toBe("");
  expect(clearAcknowledgedDraft("new draft", "sent")).toBe("new draft");
});

test("chat provider switches preserve images only for image-capable providers", () => {
  const attachments = [{
    id: "image-1",
    name: "photo.png",
    mimeType: "image/png",
    data: "cG5n",
    byteCount: 3,
  }];
  expect(providerSwitchAttachmentState(attachments, true)).toEqual({ attachments });
  expect(providerSwitchAttachmentState(attachments, false)).toEqual({
    attachments: [],
    error: "Staged images were removed because the provider does not support image attachments.",
  });
});

test("capability loss clears staged images while preserving text recovery", () => {
  const attachments = [{
    id: "image-1",
    name: "photo.png",
    mimeType: "image/png",
    data: "cG5n",
    byteCount: 3,
  }];
  expect(imageAttachmentAllowed("unknown")).toBe(false);
  expect(providerSwitchAttachmentState(
    attachments,
    imageAttachmentAllowed("unknown"),
  )).toEqual({
    attachments: [],
    error: "Staged images were removed because the provider does not support image attachments.",
  });
  const chatSource = readFileSync(join(import.meta.dir, "../src/components/Chat.tsx"), "utf8");
  expect(chatSource).toContain("invalidateForUnsupportedProvider");
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
  expect(html).toContain("App-wide");
});
