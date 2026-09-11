import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
} from "react";
import type { ImagePromptCapability, PromptAttachment } from "../session";

const MAX_ATTACHMENTS = 4;
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const SUPPORTED_IMAGE_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

const capabilityMessages = {
  en: {
    image: "+ Image",
    unknown: "Connecting to Boss. Checking image support…",
    unsupported: "This runtime did not advertise image support. You can still send text.",
  },
  ja: {
    image: "+ 画像",
    unknown: "Boss に接続しています。画像への対応を確認しています。",
    unsupported: "このランタイムは画像への対応を通知していません。テキストは送信できます。",
  },
};

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

export function canonicalImageFileName(name: string): string {
  const trimmed = name.trim();
  return trimmed.split("/").at(-1) || "image";
}

async function readImage(file: File): Promise<PromptAttachment> {
  const name = canonicalImageFileName(file.name);
  if (!SUPPORTED_IMAGE_TYPES.has(file.type)) {
    throw new Error(`${name} is not a supported image type.`);
  }

  if (file.size <= 0 || file.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(`${name} must be smaller than 8 MB.`);
  }
  return {
    id: crypto.randomUUID(),
    name,
    mimeType: file.type,
    data: bytesToBase64(new Uint8Array(await file.arrayBuffer())),
    byteCount: file.size,
  };
}

export async function readImageAttachmentForTest(file: File): Promise<PromptAttachment> {
  return readImage(file);
}

function hasFilePayload(dataTransfer: DataTransfer): boolean {
  return dataTransfer.files.length > 0
    || Array.from(dataTransfer.items).some((item) => item.kind === "file")
    || Array.from(dataTransfer.types).includes("Files");
}

export function availableImageAttachmentSlots(current: number, pending: number): number {
  return Math.max(0, MAX_ATTACHMENTS - current - pending);
}

export function imageFileInteraction(enabled: boolean, hasFiles: boolean, locked = false): {
  preventNavigation: boolean;
  acceptFiles: boolean;
} {
  return {
    preventNavigation: hasFiles,
    acceptFiles: hasFiles && enabled && !locked,
  };
}

export function imageAttachmentBatchIsCurrent(batchGeneration: number, currentGeneration: number): boolean {
  return batchGeneration === currentGeneration;
}

export function imagePromptCanSubmit(
  text: string,
  attachmentCount: number,
  attachmentLoading: boolean,
): boolean {
  return !attachmentLoading && (text.trim().length > 0 || attachmentCount > 0);
}

export function useImageAttachments(
  enabled: boolean,
  initialAttachments: PromptAttachment[] = [],
  locked = false,
) {
  const [attachments, setAttachments] = useState<PromptAttachment[]>(initialAttachments);
  const attachmentsRef = useRef(initialAttachments);
  const pendingAttachmentCountRef = useRef(0);
  const generationRef = useRef(0);
  const [pendingAttachmentCount, setPendingAttachmentCount] = useState(0);
  const [error, setError] = useState("");
  const [dragActive, setDragActive] = useState(false);

  useEffect(() => {
    const preventFileNavigation = (event: globalThis.DragEvent) => {
      if (!event.dataTransfer || !hasFilePayload(event.dataTransfer)) return;
      event.preventDefault();
    };
    window.addEventListener("dragover", preventFileNavigation);
    window.addEventListener("drop", preventFileNavigation);
    return () => {
      window.removeEventListener("dragover", preventFileNavigation);
      window.removeEventListener("drop", preventFileNavigation);
    };
  }, []);

  const addFiles = useCallback(async (files: Iterable<File>) => {
    const incoming = Array.from(files);
    if (incoming.length === 0) return;
    if (locked) {
      setError("Wait for the current message to be accepted before changing attachments.");
      return;
    }
    if (!enabled) {
      setError("This provider does not support image attachments.");
      return;
    }
    const remaining = availableImageAttachmentSlots(
      attachmentsRef.current.length,
      pendingAttachmentCountRef.current,
    );
    if (remaining <= 0 || incoming.length > remaining) {
      setError(`Attach up to ${MAX_ATTACHMENTS} images per message.`);
      return;
    }
    pendingAttachmentCountRef.current += incoming.length;
    setPendingAttachmentCount(pendingAttachmentCountRef.current);
    const generation = generationRef.current;
    try {
      const next = await Promise.all(incoming.map(readImage));
      if (!imageAttachmentBatchIsCurrent(generation, generationRef.current)) return;
      const updated = [...attachmentsRef.current, ...next];
      attachmentsRef.current = updated;
      setAttachments(updated);
      setError("");
    } catch (caught) {
      if (!imageAttachmentBatchIsCurrent(generation, generationRef.current)) return;
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (imageAttachmentBatchIsCurrent(generation, generationRef.current)) {
        pendingAttachmentCountRef.current = Math.max(
          0,
          pendingAttachmentCountRef.current - incoming.length,
        );
        setPendingAttachmentCount(pendingAttachmentCountRef.current);
      }
    }
  }, [enabled, locked]);

  const remove = useCallback((id: string) => {
    const updated = attachmentsRef.current.filter((attachment) => attachment.id !== id);
    attachmentsRef.current = updated;
    setAttachments(updated);
    setError("");
  }, []);

  const clear = useCallback(() => {
    generationRef.current += 1;
    attachmentsRef.current = [];
    pendingAttachmentCountRef.current = 0;
    setPendingAttachmentCount(0);
    setAttachments([]);
    setError("");
    setDragActive(false);
  }, []);

  const invalidateForUnsupportedProvider = useCallback((message: string) => {
    const hadAttachments = attachmentsRef.current.length > 0
      || pendingAttachmentCountRef.current > 0;
    generationRef.current += 1;
    attachmentsRef.current = [];
    pendingAttachmentCountRef.current = 0;
    setPendingAttachmentCount(0);
    setAttachments([]);
    setError(hadAttachments ? message : "");
    setDragActive(false);
  }, []);

  const onDragEnter = useCallback((event: DragEvent<HTMLElement>) => {
    const interaction = imageFileInteraction(enabled, hasFilePayload(event.dataTransfer), locked);
    if (!interaction.preventNavigation) return;
    event.preventDefault();
    event.stopPropagation();
    if (locked) {
      setError("Wait for the current message to be accepted before changing attachments.");
      return;
    }
    if (!interaction.acceptFiles) {
      setError("This provider does not support image attachments.");
      return;
    }
    setDragActive(true);
  }, [enabled, locked]);

  const onDragOver = useCallback((event: DragEvent<HTMLElement>) => {
    const interaction = imageFileInteraction(enabled, hasFilePayload(event.dataTransfer), locked);
    if (!interaction.preventNavigation) return;
    event.preventDefault();
    event.stopPropagation();
    if (locked) {
      event.dataTransfer.dropEffect = "none";
      setError("Wait for the current message to be accepted before changing attachments.");
      return;
    }
    if (!interaction.acceptFiles) {
      event.dataTransfer.dropEffect = "none";
      setError("This provider does not support image attachments.");
      return;
    }
    event.dataTransfer.dropEffect = "copy";
    setDragActive(true);
  }, [enabled, locked]);

  const onDragLeave = useCallback((event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setDragActive(false);
  }, []);

  const onDrop = useCallback((event: DragEvent<HTMLElement>) => {
    const interaction = imageFileInteraction(enabled, hasFilePayload(event.dataTransfer), locked);
    if (!interaction.preventNavigation) return;
    event.preventDefault();
    event.stopPropagation();
    setDragActive(false);
    if (locked) {
      setError("Wait for the current message to be accepted before changing attachments.");
      return;
    }
    if (!interaction.acceptFiles) {
      setError("This provider does not support image attachments.");
      return;
    }
    void addFiles(event.dataTransfer.files);
  }, [addFiles, enabled, locked]);

  const onPaste = useCallback((event: ClipboardEvent<HTMLTextAreaElement>) => {
    const hasFiles = hasFilePayload(event.clipboardData);
    const images = Array.from(event.clipboardData.files).filter((file) =>
      file.type.startsWith("image/"));
    const interaction = imageFileInteraction(enabled, hasFiles, locked);
    if (!interaction.preventNavigation) return;
    event.preventDefault();
    if (locked) {
      setError("Wait for the current message to be accepted before changing attachments.");
      return;
    }
    if (!interaction.acceptFiles) {
      setError("This provider does not support image attachments.");
      return;
    }
    if (images.length === 0) {
      setError("Pasted file is not a supported image type.");
      return;
    }
    void addFiles(images);
  }, [addFiles, enabled, locked]);

  return {
    attachments,
    loading: pendingAttachmentCount > 0,
    error,
    dragActive,
    addFiles,
    remove,
    clear,
    invalidateForUnsupportedProvider,
    dropHandlers: { onDragEnter, onDragOver, onDragLeave, onDrop },
    onPaste,
  };
}

export function ImageAttachmentTray({
  attachments,
  enabled,
  capability,
  error,
  onAdd,
  onRemove,
  locked = false,
  loading = false,
}: {
  attachments: PromptAttachment[];
  enabled: boolean;
  capability?: ImagePromptCapability;
  error: string;
  onAdd(files: FileList): void;
  onRemove(id: string): void;
  locked?: boolean;
  loading?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const capabilityId = useId();
  const locale = typeof navigator === "undefined" ? "en" : navigator.language ?? "en";
  const text = capabilityMessages[locale.toLowerCase().startsWith("ja") ? "ja" : "en"];
  const explanation = capability && capability !== "supported" ? text[capability] : "";
  if (!enabled && !explanation && attachments.length === 0 && !loading) {
    return error
      ? <div className="image-attachment-controls"><span className="image-attachment-error" role="alert">{error}</span></div>
      : null;
  }
  return (
    <>
      {attachments.length > 0 ? (
        <div className="image-attachment-tray" aria-label="Attached images">
          {attachments.map((attachment) => (
            <div className="image-attachment" key={attachment.id}>
              <img
                src={`data:${attachment.mimeType};base64,${attachment.data}`}
                alt={attachment.name}
              />
              <span title={attachment.name}>{attachment.name}</span>
              <button
                type="button"
                aria-label={`Remove ${attachment.name}`}
                disabled={locked}
                onClick={() => onRemove(attachment.id)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      ) : null}
      <div className="image-attachment-controls">
        {enabled || explanation ? (
          <>
            <button
              type="button"
              className="attach-image"
              disabled={!enabled || locked}
              title={explanation || undefined}
              aria-describedby={explanation ? capabilityId : undefined}
              onClick={() => inputRef.current?.click()}
            >
              {capability ? text.image : "+ Image"}
            </button>
            <input
              ref={inputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              multiple
              hidden
              disabled={!enabled || locked}
              onChange={(event) => {
                if (event.target.files) onAdd(event.target.files);
                event.target.value = "";
              }}
            />
          </>
        ) : null}
        {explanation ? <span id={capabilityId} className="image-attachment-loading" role="status">{explanation}</span> : null}
        {loading ? <span className="image-attachment-loading" role="status">Loading image…</span> : null}
        {error ? <span className="image-attachment-error" role="alert">{error}</span> : null}
      </div>
    </>
  );
}
