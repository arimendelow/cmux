import { expect, test } from "bun:test";
import {
  availableImageAttachmentSlots,
  canonicalImageFileName,
  imageAttachmentBatchIsCurrent,
  imageFileInteraction,
  imagePromptCanSubmit,
  readImageAttachmentForTest,
} from "../src/components/ImageAttachments";

test("image attachment reader produces bounded ACP payloads", async () => {
  const attachment = await readImageAttachmentForTest(
    new File([Buffer.from("png")], "screenshot.png", { type: "image/png" }),
  );

  expect(attachment).toMatchObject({
    name: "screenshot.png",
    mimeType: "image/png",
    data: "cG5n",
    byteCount: 3,
  });
  expect(attachment.id).toMatch(/^[0-9a-f-]{36}$/);
});

test("image filenames use the same canonical basename as the server", async () => {
  expect(canonicalImageFileName("  screenshot.png  ")).toBe("screenshot.png");
  expect(canonicalImageFileName("../../nested/photo.webp")).toBe("photo.webp");
  const attachment = await readImageAttachmentForTest(
    new File([Buffer.from("png")], "  screenshot.png  ", { type: "image/png" }),
  );
  expect(attachment.name).toBe("screenshot.png");
});

test("image attachment reader rejects unsupported and oversized files", async () => {
  await expect(readImageAttachmentForTest(
    new File([Buffer.from("pdf")], "document.pdf", { type: "application/pdf" }),
  )).rejects.toThrow("not a supported image type");
  await expect(readImageAttachmentForTest(
    new File([new Uint8Array(8 * 1024 * 1024 + 1)], "huge.png", { type: "image/png" }),
  )).rejects.toThrow("smaller than 8 MB");
});

test("concurrent image reads reserve against the four-image message limit", () => {
  expect(availableImageAttachmentSlots(0, 0)).toBe(4);
  expect(availableImageAttachmentSlots(1, 2)).toBe(1);
  expect(availableImageAttachmentSlots(3, 2)).toBe(0);
});

test("clearing the composer invalidates completed asynchronous image reads", () => {
  expect(imageAttachmentBatchIsCurrent(3, 3)).toBe(true);
  expect(imageAttachmentBatchIsCurrent(3, 4)).toBe(false);
});

test("prompt submission waits for selected images to finish loading", () => {
  expect(imagePromptCanSubmit("inspect", 0, true)).toBe(false);
  expect(imagePromptCanSubmit("", 1, true)).toBe(false);
  expect(imagePromptCanSubmit("inspect", 0, false)).toBe(true);
  expect(imagePromptCanSubmit("", 1, false)).toBe(true);
});

test("image file interactions always prevent browser navigation", () => {
  expect(imageFileInteraction(true, true)).toEqual({
    preventNavigation: true,
    acceptFiles: true,
  });
  expect(imageFileInteraction(false, true)).toEqual({
    preventNavigation: true,
    acceptFiles: false,
  });
  expect(imageFileInteraction(true, false)).toEqual({
    preventNavigation: false,
    acceptFiles: false,
  });
  expect(imageFileInteraction(true, true, true)).toEqual({
    preventNavigation: true,
    acceptFiles: false,
  });
});
