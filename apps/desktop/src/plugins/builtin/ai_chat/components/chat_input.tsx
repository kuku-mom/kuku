import { createEffect, createMemo, createSignal, For, onCleanup, Show, type JSX } from "solid-js";

import ScrollArea from "~/components/scroll_area";
import { t, tf } from "~/i18n";
import type { WikilinkSuggestItem } from "~/plugins/builtin/wikilink/wikilink_suggest";
import { vaultState } from "~/stores/vault";

import {
  addFileAttachment,
  chatState,
  isSessionBusy,
  cancelSession,
  ensureSession,
  removeFileAttachment,
  sendMessage,
  setAutoApprove,
  setDraft,
  setPermissionPreset,
  switchMode,
} from "../chat_store";
import {
  fileAttachmentFromSuggestion,
  getFileEmbedSuggestions,
  resolveFileMentionTrigger,
  type FileMentionTrigger,
} from "../file_embed";
import {
  getPermissionPreset,
  getPermissionPresetOptions,
  type ChatPermissionPresetId,
} from "../permission_presets";
import type { ChatMode } from "../types";

const MODE_OPTIONS: {
  value: ChatMode;
  title: Parameters<typeof t>[0];
  desc: Parameters<typeof t>[0];
}[] = [
  { value: "agent", title: "chat.mode.agent.title", desc: "chat.mode.agent.desc" },
  { value: "ask", title: "chat.mode.ask.title", desc: "chat.mode.ask.desc" },
  { value: "inline", title: "chat.mode.inline.title", desc: "chat.mode.inline.desc" },
];

function modeTitle(mode: ChatMode): string {
  switch (mode) {
    case "agent":
      return t("chat.mode.agent.title");
    case "ask":
      return t("chat.mode.ask.title");
    case "inline":
      return t("chat.mode.inline.title");
    default:
      return mode;
  }
}

function ChatInput(): JSX.Element {
  let textareaRef: HTMLTextAreaElement | undefined;
  let fileSuggestionMenuRef: HTMLElement | undefined;
  let modeMenuRootRef: HTMLDivElement | undefined;
  let permissionMenuRootRef: HTMLDivElement | undefined;
  let permissionMenuRef: HTMLDivElement | undefined;
  const [draft, setLocalDraft] = createSignal("");
  const [fileMention, setFileMention] = createSignal<FileMentionTrigger | null>(null);
  const [fileMentionIndex, setFileMentionIndex] = createSignal(0);
  const [showModeMenu, setShowModeMenu] = createSignal(false);
  const [showPermissionMenu, setShowPermissionMenu] = createSignal(false);

  const session = () =>
    chatState.activeSessionId ? (chatState.sessions[chatState.activeSessionId] ?? null) : null;
  const isLocked = () =>
    chatState.isCreatingSession ||
    chatState.isSendingMessage ||
    (session()?.status ?? "idle") !== "idle";
  const isBusy = () => isSessionBusy(session());
  const attachedFiles = () => session()?.fileAttachments ?? [];
  const autoApproveEnabled = () => session()?.autoApprove ?? false;
  const canShowAutoApprove = () =>
    chatState.selectedMode === "agent" || chatState.selectedMode === "inline";
  const permissionPresetsEnabled = () => false;
  const permissionOptions = () => getPermissionPresetOptions(t);
  const selectedPermissionOption = () =>
    !permissionPresetsEnabled()
      ? permissionOptions()[0]
      : (permissionOptions().find((option) => option.id === chatState.permissionPreset) ??
        permissionOptions()[0]);
  const fileSuggestions = createMemo(() => {
    const mention = fileMention();
    if (!mention) return [];
    const attached = new Set(attachedFiles().map((file) => file.path));
    return getFileEmbedSuggestions(vaultState.files, mention.query).filter(
      (item) => !attached.has(item.path),
    );
  });

  createEffect(() => {
    const activeId = chatState.activeSessionId;
    if (!activeId) {
      setLocalDraft("");
      return;
    }
    setLocalDraft(chatState.sessions[activeId]?.draft ?? "");
  });

  createEffect(() => {
    const suggestions = fileSuggestions();
    if (fileMentionIndex() >= suggestions.length) {
      setFileMentionIndex(Math.max(0, suggestions.length - 1));
    }
  });

  createEffect(() => {
    if (!fileMention()) return;
    fileMentionIndex();
    fileSuggestions();
    requestAnimationFrame(() => {
      fileSuggestionMenuRef
        ?.querySelector<HTMLElement>('[data-file-suggestion-selected="true"]')
        ?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
  });

  /** Close mode menu on outside press or Escape. */
  createEffect(() => {
    if (!showModeMenu() && !showPermissionMenu()) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (modeMenuRootRef != null && !modeMenuRootRef.contains(target)) {
        setShowModeMenu(false);
      }
      if (permissionMenuRootRef != null && !permissionMenuRootRef.contains(target)) {
        if (permissionMenuRef == null || !permissionMenuRef.contains(target)) {
          setShowPermissionMenu(false);
        }
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setShowModeMenu(false);
        setShowPermissionMenu(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    onCleanup(() => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    });
  });

  async function submit(): Promise<void> {
    const value = draft();
    if (!value.trim()) return;
    const sent = await sendMessage(value);
    if (sent) {
      setLocalDraft("");
      setFileMention(null);
    }
  }

  async function toggleAutoApprove(checked: boolean): Promise<void> {
    const sessionId = await ensureSession();
    if (!sessionId) return;
    setAutoApprove(sessionId, checked);
  }

  function selectPermissionPreset(presetId: ChatPermissionPresetId): void {
    const preset = getPermissionPreset(presetId);
    if (preset.requiresConfirmation) {
      const confirmAccess = globalThis.confirm?.(t("chat.permission.full_access.confirm")) ?? true;
      if (!confirmAccess) return;
    }

    setPermissionPreset(presetId);
    setShowPermissionMenu(false);
  }

  function handleKeyDown(e: KeyboardEvent): void {
    const suggestions = fileSuggestions();
    if (fileMention() && suggestions.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setFileMentionIndex((index) => (index + 1) % suggestions.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setFileMentionIndex((index) => (index - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        void applyFileSuggestion(suggestions[fileMentionIndex()]);
        return;
      }
    }

    if (fileMention() && e.key === "Escape") {
      e.preventDefault();
      setFileMention(null);
      return;
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  }

  function handleKeyUp(e: KeyboardEvent): void {
    if (fileMention() && ["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(e.key)) {
      return;
    }
    refreshFileMention();
  }

  function updateDraft(value: string): void {
    setLocalDraft(value);
    setDraft(value);
    refreshFileMention();
  }

  function refreshFileMention(): void {
    const textarea = textareaRef;
    if (!textarea || isLocked()) {
      setFileMention(null);
      return;
    }

    const mention = resolveFileMentionTrigger(textarea.value, textarea.selectionStart);
    setFileMention(mention);
    setFileMentionIndex(0);
  }

  async function applyFileSuggestion(item: WikilinkSuggestItem | undefined): Promise<void> {
    const mention = fileMention();
    if (!mention || !item) return;

    const nextDraft = `${draft().slice(0, mention.from)}${draft().slice(mention.to)}`;
    const attached = await addFileAttachment(fileAttachmentFromSuggestion(item));
    if (!attached) return;

    setLocalDraft(nextDraft);
    setDraft(nextDraft);
    setFileMention(null);

    requestAnimationFrame(() => {
      textareaRef?.focus();
      textareaRef?.setSelectionRange(mention.from, mention.from);
    });
  }

  return (
    <div class="relative focus-within:outline-none" data-kuku-ai-chat-composer>
      <Show when={canShowAutoApprove()}>
        <label
          data-kuku-auto-accept-tab
          class="absolute top-0 left-5 z-10 inline-flex h-6 -translate-y-[calc(100%-1px)] cursor-pointer items-center gap-1 border-y border-b-0 border-border bg-bg-secondary px-1.5 text-[0.68rem] font-medium text-text-muted transition-colors hover:bg-bg-secondary hover:text-text-secondary"
          title={
            autoApproveEnabled()
              ? t("chat.header.auto_accept.on_title")
              : t("chat.header.auto_accept.off_title")
          }
        >
          <input
            type="checkbox"
            class="peer sr-only"
            checked={autoApproveEnabled()}
            disabled={chatState.isCreatingSession}
            onChange={(event) => void toggleAutoApprove(event.currentTarget.checked)}
          />
          <span
            class="grid size-2.5 place-items-center border transition"
            classList={{
              "border-text-primary bg-text-primary text-bg-primary": autoApproveEnabled(),
              "border-border-focused bg-bg-primary text-transparent hover:border-border-selected hover:bg-bg-secondary":
                !autoApproveEnabled(),
            }}
            aria-hidden="true"
          >
            <svg
              width="7"
              height="7"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="4"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M20 6 9 17l-5-5" />
            </svg>
          </span>
          <span class="-translate-y-px">{t("chat.header.auto_accept")}</span>
        </label>
      </Show>

      <Show when={fileMention()}>
        <div class="absolute bottom-full left-2 z-50 mb-1 w-[min(100%,20rem)] overflow-hidden rounded-sm border border-border/70 bg-bg-elevated p-0.5 sm:left-2.5">
          <ScrollArea
            axis="y"
            scrollbarVisibility="hidden"
            class="max-h-56"
            handleRef={(handle) => {
              fileSuggestionMenuRef = handle.viewport;
            }}
          >
            <Show
              when={fileSuggestions().length > 0}
              fallback={
                <p class="px-2.5 py-2 text-[0.75rem] text-text-muted">
                  {t("chat.input.no_matching_files")}
                </p>
              }
            >
              <For each={fileSuggestions()}>
                {(item, index) => (
                  <button
                    type="button"
                    class="flex w-full flex-col rounded-sm px-2.5 py-1.5 text-left transition hover:bg-ghost-hover"
                    classList={{
                      "bg-ghost-hover": fileMentionIndex() === index(),
                    }}
                    data-file-suggestion-selected={
                      fileMentionIndex() === index() ? "true" : undefined
                    }
                    onMouseDown={(event) => {
                      event.preventDefault();
                      void applyFileSuggestion(item);
                    }}
                  >
                    <span class="truncate text-[0.75rem] text-text-primary">{item.name}</span>
                    <span class="truncate text-[0.65rem] text-text-muted">
                      {item.folder || t("chat.input.vault_root")}
                    </span>
                  </button>
                )}
              </For>
            </Show>
          </ScrollArea>
        </div>
      </Show>

      <Show when={permissionPresetsEnabled() && showPermissionMenu()}>
        <div
          ref={(el) => (permissionMenuRef = el)}
          data-kuku-permission-menu="true"
          class="absolute right-2 bottom-11 left-2 z-50 overflow-hidden rounded-sm border border-border bg-bg-elevated py-1 shadow-popover sm:right-2.5 sm:left-2.5"
        >
          <For each={permissionOptions()}>
            {(option) => (
              <button
                type="button"
                class="flex w-full flex-col items-start gap-0.5 p-2.5 text-left transition hover:bg-ghost-hover"
                classList={{
                  "bg-ghost-hover": chatState.permissionPreset === option.id,
                }}
                onClick={() => selectPermissionPreset(option.id)}
              >
                <span class="text-[0.8125rem] font-medium text-text-primary">{option.label}</span>
                <span class="text-xs/snug text-text-muted">{option.description}</span>
              </button>
            )}
          </For>
        </div>
      </Show>

      <div
        class="px-2 py-1.5 sm:px-2.5"
        classList={{ "pointer-events-none opacity-50": isLocked() }}
      >
        <Show when={attachedFiles().length > 0}>
          <div class="mb-1.5 flex flex-wrap gap-1">
            <For each={attachedFiles()}>
              {(file) => (
                <span class="inline-flex max-w-full items-center gap-1 rounded-sm border border-border/50 bg-bg-primary/50 px-1.5 py-0.5 text-[0.65rem] text-text-muted">
                  <span class="truncate" title={file.path}>
                    @{file.name}
                  </span>
                  <button
                    type="button"
                    class="text-text-muted/80 hover:text-text-secondary disabled:opacity-40"
                    disabled={isLocked()}
                    aria-label={tf("chat.input.remove_file", { name: file.name })}
                    onClick={() => removeFileAttachment(file.path)}
                  >
                    ×
                  </button>
                </span>
              )}
            </For>
          </div>
        </Show>

        <textarea
          ref={textareaRef}
          rows={1}
          value={draft()}
          placeholder={
            chatState.selectedMode === "agent"
              ? t("chat.input.placeholder.agent")
              : t("chat.input.placeholder.ask")
          }
          class="kuku-ai-composer-textarea min-h-18 w-full resize-none bg-transparent py-1 text-[0.8125rem] leading-normal text-text-primary outline-none selection:bg-ghost-selected placeholder:text-text-muted/70"
          disabled={isLocked()}
          onInput={(event) => {
            updateDraft(event.currentTarget.value);
          }}
          onKeyDown={handleKeyDown}
          onClick={refreshFileMention}
          onKeyUp={handleKeyUp}
        />

        <div class="mt-0.5 flex min-h-8 items-center justify-between gap-2 border-t border-border/50 pt-1.5">
          <div class="flex min-w-0 items-center gap-2">
            <div class="relative" ref={(el) => (modeMenuRootRef = el)}>
              <button
                type="button"
                class="inline-flex min-h-7 -translate-y-px items-center gap-1 rounded-sm px-1.5 py-1 text-[0.8125rem] font-medium text-text-secondary transition hover:bg-ghost-hover hover:text-text-primary"
                onClick={() => setShowModeMenu(!showModeMenu())}
              >
                <span class="max-w-24 truncate capitalize sm:max-w-none">
                  {modeTitle(chatState.selectedMode)}
                </span>
                <svg
                  class="shrink-0 translate-y-px text-text-muted"
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  aria-hidden="true"
                >
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>
              <Show when={showModeMenu()}>
                <div class="absolute bottom-full left-0 z-50 mb-1.5 w-[min(100vw-1rem,17rem)] min-w-[16rem] overflow-hidden rounded-sm border border-border bg-bg-elevated py-1">
                  <For each={MODE_OPTIONS}>
                    {(opt) => (
                      <button
                        type="button"
                        class="flex w-full flex-col items-start gap-0.5 p-2.5 text-left transition hover:bg-ghost-hover"
                        classList={{
                          "bg-ghost-hover": chatState.selectedMode === opt.value,
                        }}
                        onClick={() => {
                          void switchMode(opt.value);
                          setShowModeMenu(false);
                        }}
                      >
                        <span class="text-[0.8125rem] font-medium text-text-primary">
                          {t(opt.title)}
                        </span>
                        <span class="text-xs/snug text-text-muted">{t(opt.desc)}</span>
                      </button>
                    )}
                  </For>
                </div>
              </Show>
            </div>
            <div class="relative" ref={(el) => (permissionMenuRootRef = el)}>
              <button
                type="button"
                data-kuku-permission-preset-trigger="true"
                disabled
                class="inline-flex min-h-7 -translate-y-px cursor-not-allowed items-center gap-1 rounded-sm px-1.5 py-1 text-[0.75rem] font-medium text-text-muted/60 opacity-70"
                title={t("chat.permission.selector.disabled")}
              >
                <span class="max-w-24 truncate sm:max-w-none">
                  {selectedPermissionOption().label}
                </span>
                <svg
                  class="shrink-0 translate-y-px text-text-muted"
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  aria-hidden="true"
                >
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>
            </div>
          </div>

          <div class="shrink-0">
            <Show
              when={isBusy()}
              fallback={
                <button
                  type="button"
                  disabled={isLocked() || !draft().trim()}
                  class="flex size-7 items-center justify-center rounded-sm text-text-secondary transition hover:bg-ghost-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent"
                  title={t("chat.input.send")}
                  onClick={() => void submit()}
                >
                  <svg
                    class="shrink-0"
                    width="15"
                    height="15"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.75"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <path d="M12 19V5M5 12l7-7 7 7" />
                  </svg>
                </button>
              }
            >
              <button
                type="button"
                class="flex size-7 items-center justify-center rounded-sm text-text-secondary transition hover:bg-ghost-hover hover:text-text-primary"
                title={t("chat.input.stop")}
                onClick={() => void cancelSession()}
              >
                <svg
                  class="shrink-0"
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linejoin="round"
                >
                  <rect x="6" y="6" width="12" height="12" rx="2" />
                </svg>
              </button>
            </Show>
          </div>
        </div>
      </div>
    </div>
  );
}

export { ChatInput };
