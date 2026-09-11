import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useCtx } from "../context";
import { readStoredProviderOptions, persistOptionsSnapshot, updateStoredProviderOption } from "../options-store";
import {
  imageAttachmentAllowed,
  type OptionValue,
  type PromptAttachment,
  type SessionOption,
} from "../session";
import { ArrowUp } from "./icons";
import { isCtrlJ, insertNewlineAtCaret, useCommandMenu } from "./CommandMenu";
import { optionAcceptsValue } from "./options";
import { StatusRow } from "./StatusRow";
import { Blocks } from "./Transcript";
import { WorkbenchHeader } from "./WorkbenchHeader";
import { BossStatusBanner } from "./BossStatusBanner";
import { RecoveryBanner, WorkbenchRestoreBanner } from "./RecoveryBanner";
import { ShortcutOverlay, useKeymap } from "../hooks/useKeymap";
import { useAutoGrow } from "../hooks/useAutoGrow";
import { providerOptionMap, useFileCatalog, useProviderCatalogs, withFileTrigger } from "../hooks/useCatalogs";
import {
  ImageAttachmentTray,
  imagePromptCanSubmit,
  useImageAttachments,
} from "./ImageAttachments";

function usePersistSessionOptions(provider: string | undefined, options: SessionOption[], skip = false) {
  useEffect(() => {
    if (skip || !provider || !options.length) return;
    persistOptionsSnapshot(provider, options);
  }, [provider, options, skip]);
}

function useRestoreModelScopedOptions({
  provider,
  options,
  setOption,
  pendingModelRestoreRef,
}: {
  provider: string | undefined;
  options: SessionOption[];
  setOption: (id: string, value: OptionValue) => void;
  pendingModelRestoreRef: RefObject<string | null>;
}) {
  useEffect(() => {
    const pending = pendingModelRestoreRef.current;
    if (!provider || !pending || !options.length) return;
    const model = options.find((o) => o.id === "model");
    if (model?.value !== pending) return;
    const stored = readStoredProviderOptions(provider);
    for (const id of ["effort", "context", "fastMode"]) {
      const option = options.find((o) => o.id === id);
      const value = stored[id];
      if (option && value !== undefined && option.value !== value && optionAcceptsValue(option, value)) {
        setOption(id, value as OptionValue);
      }
    }
    pendingModelRestoreRef.current = null;
  }, [options, pendingModelRestoreRef, provider, setOption]);
}

function useStickToBottom(scrollRef: RefObject<HTMLDivElement | null>, stickRef: RefObject<boolean>, blocks: unknown[], running: boolean) {
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [blocks, running, scrollRef, stickRef]);
}

export function clearAcknowledgedDraft(current: string, submitted: string): string {
  return current === submitted ? "" : current;
}

export function providerSwitchAttachmentState(
  attachments: PromptAttachment[],
  supportsImages: boolean,
): { attachments: PromptAttachment[]; error?: string } {
  if (supportsImages) return { attachments };
  return {
    attachments: [],
    ...(attachments.length > 0
      ? { error: "Staged images were removed because the provider does not support image attachments." }
      : {}),
  };
}

export function Chat() {
  const { ready, connectionEpoch, providers, capabilities, experience, boss, continuity, imageCapability, actionsAllowed, connection, recovery, restore, providerOptions, session, blocks, options, actions, commands, filesByCwd, fileDiffs, lastError, ctrlJ, forkPending, reply, stop, setOption, respondPermission, respondElicitation, fork, compose, requestProviderOptions, requestProviderCommands, requestFiles, requestFileDiff, clearError } = useCtx();
  const [text, setText] = useState("");
  const [sendPending, setSendPending] = useState(false);
  const [openOptionId, setOpenOptionId] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const taRef = useAutoGrow(text, 200);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const pendingModelRestoreRef = useRef<string | null>(null);
  const cwd = session?.cwd ?? "";
  const commandGroups = useMemo(() => withFileTrigger(commands, filesByCwd[cwd] ?? []), [commands, cwd, filesByCwd]);
  const commandMenu = useCommandMenu(text, setText, commandGroups, taRef, ctrlJ);
  const admissionPending = sendPending || session?.id.startsWith("pending-") === true;
  const imagesAllowed = imageAttachmentAllowed(imageCapability);
  const imageAttachments = useImageAttachments(
    capabilities[session?.provider ?? ""]?.imageAttachments === true && imagesAllowed,
    [],
    admissionPending,
  );
  const allProviderOptions = providerOptionMap(providers, providerOptions, capabilities);
  const running = session?.status === "running";

  useEffect(() => {
    if (imagesAllowed) return;
    imageAttachments.invalidateForUnsupportedProvider(
      "Staged images were removed because the provider does not support image attachments.",
    );
  }, [imageAttachments.invalidateForUnsupportedProvider, imagesAllowed]);

  useRestoreModelScopedOptions({ provider: session?.provider, options, setOption, pendingModelRestoreRef });
  usePersistSessionOptions(session?.provider, options, pendingModelRestoreRef.current !== null);
  useProviderCatalogs(ready, connectionEpoch, providers, session?.provider ?? "", cwd, requestProviderOptions, requestProviderCommands);
  useFileCatalog(ready, connectionEpoch, cwd, requestFiles);
  useStickToBottom(scrollRef, stickRef, blocks, running);
  useKeymap({
    options,
    setOption,
    running,
    stop,
    helpOpen,
    setHelpOpen,
    popupOpen: commandMenu.open || Boolean(openOptionId),
    closePopup: () => {
      commandMenu.close();
      setOpenOptionId(null);
    },
    ctrlJ,
    inputRef: taRef,
    openModel: () => setOpenOptionId("modelPicker"),
    disabled: admissionPending,
  });

  const onScroll = () => {
    const el = scrollRef.current;
    if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };
  const submit = async () => {
    const t = text.trim();
    const hasImages = imageAttachments.attachments.length > 0;
    if (!actionsAllowed.compose || admissionPending || (hasImages && !imagesAllowed) || !imagePromptCanSubmit(
      t,
      imageAttachments.attachments.length,
      imageAttachments.loading,
    )) return;
    const submittedText = text;
    stickRef.current = true;
    commandMenu.close();
    setOpenOptionId(null);
    setSendPending(true);
    try {
      const accepted = await reply(t, imageAttachments.attachments);
      if (!accepted) return;
      setText((current) => clearAcknowledgedDraft(current, submittedText));
      imageAttachments.clear();
    } finally {
      setSendPending(false);
    }
  };
  const switchHarnessModel = (provider: string, model: string) => {
    if (!session) return;
    if (provider === session.provider) {
      if (model) {
        updateStoredProviderOption(provider, "model", model, options);
        pendingModelRestoreRef.current = model;
        setOption("model", model);
      }
      setOpenOptionId(null);
      return;
    }
    if (!actionsAllowed.compose) return;
    updateStoredProviderOption(provider, "model", model, allProviderOptions[provider] ?? []);
    localStorage.setItem("agentui.provider", provider);
    localStorage.setItem("agentui.cwd", session.cwd);
    sessionStorage.setItem("agentui.draft", text);
    const attachmentState = providerSwitchAttachmentState(
      imageAttachments.attachments,
      capabilities[provider]?.imageAttachments === true,
    );
    compose({
      ...attachmentState,
    });
  };

  return (
    <section id="chat-view" data-image-capability={imageCapability} data-images-allowed={imagesAllowed ? "1" : "0"}>
      {experience ? <WorkbenchHeader experience={experience} continuity={continuity} compact /> : null}
      <BossStatusBanner boss={boss} />
      {restore ? <WorkbenchRestoreBanner receipt={restore} /> : connection ? (
        <div className="recovery-banner-wrap">
          <div className="recovery-banner startup-banner" role="status">
            <strong>{connection.title}</strong>
            {connection.message ? <span>{connection.message}</span> : null}
          </div>
        </div>
      ) : recovery ? <RecoveryBanner recovery={recovery} /> : null}
      <div id="messages" ref={scrollRef} onScroll={onScroll}>
        <Blocks
          blocks={blocks}
          status={session?.status}
          actions={actionsAllowed.fork ? actions : {}}
          onFork={fork}
          forkPending={forkPending}
          fileDiffs={fileDiffs}
          onFileDiff={(path) => { if (session) requestFileDiff(session.id, path); }}
          onPermissionResponse={respondPermission}
          onElicitationResponse={respondElicitation}
        />
      </div>
      <div id="chat-input-row">
        <div
          id="chat-card"
          className={imageAttachments.dragActive ? "image-drop-active" : undefined}
          {...imageAttachments.dropHandlers}
        >
          <ImageAttachmentTray
            attachments={imageAttachments.attachments}
            enabled={capabilities[session?.provider ?? ""]?.imageAttachments === true && imagesAllowed}
            error={imageAttachments.error}
            locked={admissionPending}
            loading={imageAttachments.loading}
            onAdd={(files) => { void imageAttachments.addFiles(files); }}
            onRemove={imageAttachments.remove}
          />
          <div className="input-wrap chat-text-wrap">
            <textarea
              ref={taRef}
              id="chat-input"
              data-primary-textarea="true"
              placeholder="Reply…"
              value={text}
              disabled={admissionPending}
              onChange={(e) => {
                setText(e.target.value);
                if (lastError) clearError();
              }}
              onPaste={imageAttachments.onPaste}
              onSelect={commandMenu.onSelect}
              onKeyUp={commandMenu.onSelect}
              onClick={commandMenu.onSelect}
              onKeyDown={(e) => {
                if (commandMenu.onKeyDown(e)) return;
                if (isCtrlJ(e)) { e.preventDefault(); insertNewlineAtCaret(text, setText, taRef); return; }
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void submit(); }
              }}
            />
            {admissionPending ? null : commandMenu.menu}
          </div>
          <StatusRow
            provider={session?.provider ?? "agent"}
            providers={providers}
            allProviderOptions={allProviderOptions}
            onProviderModelChange={switchHarnessModel}
            cwd={session?.cwd ?? ""}
            options={options}
            onChange={setOption}
            openOptionId={openOptionId}
            setOpenOptionId={setOpenOptionId}
            running={running}
            disabled={admissionPending}
            trailing={(
              <div className="chat-actions">
                {running ? <button id="stop-btn" type="button" onClick={stop}>Stop</button> : null}
                <button
                  className="send"
                  type="button"
                  aria-label="Send"
                  disabled={!actionsAllowed.compose || admissionPending || (imageAttachments.attachments.length > 0 && !imagesAllowed) || !imagePromptCanSubmit(
                    text,
                    imageAttachments.attachments.length,
                    imageAttachments.loading,
                  )}
                  onClick={() => { void submit(); }}
                >
                  <ArrowUp />
                </button>
              </div>
            )}
          />
        </div>
      </div>
      {lastError ? <div className="composer-error">{lastError}</div> : null}
      {helpOpen ? <ShortcutOverlay provider={session?.provider ?? "agent"} options={options} running={running} ctrlJ={ctrlJ} onClose={() => setHelpOpen(false)} /> : null}
    </section>
  );
}
