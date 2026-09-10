import { useCallback, useMemo, useState } from "react";
import { composerDraftKey, type OptionValue } from "../session";
import { useCtx } from "../context";
import { readStoredProviderOptions, updateStoredProviderOption } from "../options-store";
import { ArrowUp } from "./icons";
import { StatusRow } from "./StatusRow";
import { WorkbenchHeader } from "./WorkbenchHeader";
import { isCtrlJ, insertNewlineAtCaret, useCommandMenu } from "./CommandMenu";
import { sanitizeStartOptions, withLocalValues } from "./options";
import { ShortcutOverlay, useKeymap } from "../hooks/useKeymap";
import { useAutoGrow } from "../hooks/useAutoGrow";
import {
  providerOptionMap,
  useCwdErrorFallback,
  useCwdValidation,
  useDefaultCwd,
  useFileCatalog,
  useProviderCatalogs,
  useProviderFallback,
  withFileTrigger,
} from "../hooks/useCatalogs";
import {
  ImageAttachmentTray,
  imagePromptCanSubmit,
  useImageAttachments,
} from "./ImageAttachments";

export function shouldShowProviderPicker(experience: unknown): boolean {
  return !experience;
}

export function shouldInvalidateImagesForProviderSwitch(
  currentProvider: string,
  nextProvider: string,
): boolean {
  return Boolean(currentProvider) && currentProvider !== nextProvider;
}

const readProviderOptions = readStoredProviderOptions;

export function Composer() {
  const {
    ready,
    connectionEpoch,
    providers,
    capabilities,
    defaultCwd,
    defaultProvider,
    experience,
    providerOptions,
    providerCommands,
    filesByCwd,
    cwdChecks,
    lastError,
    composerAttachments,
    ctrlJ,
    requestProviderOptions,
    requestProviderCommands,
    requestFiles,
    checkCwd,
    clearError,
    start,
  } = useCtx();
  const [provider, setProvider] = useState(() => localStorage.getItem("agentui.provider") || "");
  const [cwd, setCwd] = useState(() => localStorage.getItem("agentui.cwd") || "");
  const [committedCwd, setCommittedCwd] = useState(() => localStorage.getItem("agentui.cwd") || "");
  const [prompt, setPrompt] = useState(() => {
    const draft = sessionStorage.getItem(composerDraftKey) || "";
    sessionStorage.removeItem(composerDraftKey);
    return draft;
  });
  const [startOptionsByProvider, setStartOptionsByProvider] = useState<Record<string, Record<string, OptionValue>>>(() => ({
    [provider]: readProviderOptions(provider),
  }));
  const [openOptionId, setOpenOptionId] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const taRef = useAutoGrow(prompt, 300);
  const baseOptions = providerOptions[provider]?.length ? providerOptions[provider] : capabilities[provider]?.options ?? [];
  const allProviderOptions = providerOptionMap(providers, providerOptions, capabilities);
  const startOptions = startOptionsByProvider[provider] ?? {};
  const options = withLocalValues(baseOptions, startOptions);
  const commandGroups = useMemo(() => withFileTrigger(providerCommands[provider] ?? [], filesByCwd[committedCwd] ?? []), [committedCwd, filesByCwd, provider, providerCommands]);
  const commandMenu = useCommandMenu(prompt, setPrompt, commandGroups, taRef, ctrlJ);
  const imageAttachments = useImageAttachments(
    capabilities[provider]?.imageAttachments === true,
    composerAttachments,
  );
  const selectProvider = useCallback((nextProvider: string) => {
    if (shouldInvalidateImagesForProviderSwitch(provider, nextProvider)) {
      imageAttachments.invalidateForUnsupportedProvider(
        "Staged images were removed because the provider changed.",
      );
    }
    setProvider(nextProvider);
  }, [imageAttachments.invalidateForUnsupportedProvider, provider]);

  useDefaultCwd(defaultCwd, cwd, setCwd, committedCwd, setCommittedCwd);
  useProviderFallback(providers, provider, defaultProvider, selectProvider);
  useProviderCatalogs(ready, connectionEpoch, providers, provider, committedCwd, requestProviderOptions, requestProviderCommands);
  useFileCatalog(ready, connectionEpoch, committedCwd, requestFiles);
  useCwdValidation(ready, connectionEpoch, committedCwd, defaultCwd, cwdChecks, checkCwd, setCwd, setCommittedCwd);
  useCwdErrorFallback(lastError, defaultCwd, setCwd, setCommittedCwd);

  const setLocalOption = useCallback((id: string, value: OptionValue) => {
    setStartOptionsByProvider((all) => {
      const nextForProvider = updateStoredProviderOption(provider, id, value, options);
      return { ...all, [provider]: nextForProvider };
    });
  }, [options, provider]);
  useKeymap({
    options,
    setOption: setLocalOption,
    running: false,
    stop: () => {},
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
  });

  const submit = () => {
    const text = prompt.trim();
    if (!imagePromptCanSubmit(
      text,
      imageAttachments.attachments.length,
      imageAttachments.loading,
    ) || !ready) return;
    const runCwd = cwd.trim();
    const sent = start({
      provider,
      cwd: runCwd,
      prompt: text,
      attachments: imageAttachments.attachments,
      options: sanitizeStartOptions(startOptions, options),
    });
    if (!sent) return;
    imageAttachments.clear();
    localStorage.setItem("agentui.provider", provider);
    localStorage.setItem("agentui.cwd", runCwd);
  };
  const changeCwd = (v: string) => { setCwd(v); };
  const commitCwd = (v: string) => {
    const next = v.trim();
    if (!next) return;
    setCommittedCwd(next);
    localStorage.setItem("agentui.cwd", next);
  };
  const changeProvider = (v: string) => {
    selectProvider(v);
    setStartOptionsByProvider((all) => all[v] ? all : { ...all, [v]: readProviderOptions(v) });
    localStorage.setItem("agentui.provider", v);
  };
  const changeProviderModel = (nextProvider: string, model: string) => {
    changeProvider(nextProvider);
    setStartOptionsByProvider((all) => {
      const nextForProvider = updateStoredProviderOption(nextProvider, "model", model, allProviderOptions[nextProvider] ?? []);
      return { ...all, [nextProvider]: nextForProvider };
    });
    setOpenOptionId(null);
  };

  return (
    <section id="composer-view">
      {experience ? <WorkbenchHeader experience={experience} /> : null}
      <div
        id="composer-card"
        className={imageAttachments.dragActive ? "image-drop-active" : undefined}
        {...imageAttachments.dropHandlers}
      >
        <ImageAttachmentTray
          attachments={imageAttachments.attachments}
          enabled={capabilities[provider]?.imageAttachments === true}
          error={imageAttachments.error}
          loading={imageAttachments.loading}
          onAdd={(files) => { void imageAttachments.addFiles(files); }}
          onRemove={imageAttachments.remove}
        />
        <div className="input-wrap">
          <textarea
            ref={taRef}
            id="prompt-input"
            data-primary-textarea="true"
            placeholder="Describe a task or ask a question…"
            value={prompt}
            autoFocus
            onChange={(e) => {
              setPrompt(e.target.value);
              if (lastError) clearError();
            }}
            onPaste={imageAttachments.onPaste}
            onSelect={commandMenu.onSelect}
            onKeyUp={commandMenu.onSelect}
            onClick={commandMenu.onSelect}
            onKeyDown={(e) => {
              if (commandMenu.onKeyDown(e)) return;
              if (isCtrlJ(e)) { e.preventDefault(); insertNewlineAtCaret(prompt, setPrompt, taRef); return; }
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
            }}
          />
          {commandMenu.menu}
        </div>
        <StatusRow
          provider={provider}
          providers={providers}
          allProviderOptions={allProviderOptions}
          onProviderModelChange={shouldShowProviderPicker(experience) ? changeProviderModel : undefined}
          cwd={cwd}
          onCwdChange={changeCwd}
          onCwdCommit={commitCwd}
          options={options}
          onChange={setLocalOption}
          openOptionId={openOptionId}
          setOpenOptionId={setOpenOptionId}
          trailing={(
            <button
              className="send"
              type="button"
              aria-label="Start"
              disabled={!imagePromptCanSubmit(
                prompt,
                imageAttachments.attachments.length,
                imageAttachments.loading,
              ) || !ready}
              onClick={submit}
            >
              <ArrowUp />
            </button>
          )}
        />
      </div>
      {lastError ? <div className="composer-error">{lastError}</div> : null}
      <div id="composer-hint">Enter to start · Shift+Enter for newline · Ctrl+/ for shortcuts</div>
      {helpOpen ? <ShortcutOverlay provider={provider} options={options} running={false} ctrlJ={ctrlJ} onClose={() => setHelpOpen(false)} /> : null}
    </section>
  );
}
