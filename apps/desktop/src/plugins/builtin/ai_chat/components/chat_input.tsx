import { createEffect, createMemo, createSignal, For, Show, type JSX } from "solid-js";

import {
  addFileAttachment,
  chatState,
  isSessionBusy,
  cancelSession,
  removeFileAttachment,
  sendMessage,
  setAutoApprove,
  setDraft,
  switchMode,
} from "../chat_store";
import {
  fileAttachmentFromSuggestion,
  getFileEmbedSuggestions,
  resolveFileMentionTrigger,
  type FileMentionTrigger,
} from "../file_embed";
import type { ChatMode } from "../types";
import type { WikilinkSuggestItem } from "~/plugins/builtin/wikilink/wikilink_suggest";
import { vaultState } from "~/stores/vault";

const MODE_OPTIONS: { value: ChatMode; title: string; desc: string }[] = [
  { value: "agent", title: "Agent", desc: "Search, edit and create notes" },
  { value: "ask", title: "Ask", desc: "Answer questions only" },
  { value: "inline", title: "Inline", desc: "Inline editing assistance" },
];

function ChatInput(): JSX.Element {
  let textareaRef: HTMLTextAreaElement | undefined;
  const [draft, setLocalDraft] = createSignal("");
  const [fileMention, setFileMention] = createSignal<FileMentionTrigger | null>(null);
  const [fileMentionIndex, setFileMentionIndex] = createSignal(0);
  const [showModeMenu, setShowModeMenu] = createSignal(false);

  const session = () =>
    chatState.activeSessionId ? (chatState.sessions[chatState.activeSessionId] ?? null) : null;
  const isLocked = () =>
    chatState.isCreatingSession ||
    chatState.isSendingMessage ||
    (session()?.status ?? "idle") !== "idle";
  const isBusy = () => isSessionBusy(session());
  const attachedFiles = () => session()?.fileAttachments ?? [];
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

  async function submit(): Promise<void> {
    const value = draft();
    if (!value.trim()) return;
    const sent = await sendMessage(value);
    if (sent) {
      setLocalDraft("");
      setFileMention(null);
    }
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
    <div class="relative border-y border-border bg-bg-secondary transition-colors focus-within:border-border-focused">
      <Show when={fileMention()}>
        <div class="absolute bottom-full left-2 z-50 mb-1 max-h-56 w-80 overflow-y-auto rounded-xs border border-border bg-bg-primary p-1 shadow-lg">
          <Show
            when={fileSuggestions().length > 0}
            fallback={<p class="px-3 py-2 text-xs text-text-muted">No matching markdown files</p>}
          >
            <For each={fileSuggestions()}>
              {(item, index) => (
                <button
                  type="button"
                  class="flex w-full flex-col rounded-xs px-3 py-2 text-left transition-colors hover:bg-bg-elevated"
                  classList={{
                    "bg-ghost-hover": fileMentionIndex() === index(),
                  }}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    void applyFileSuggestion(item);
                  }}
                >
                  <span class="truncate text-xs font-medium text-text-primary">{item.name}</span>
                  <span class="truncate text-[0.6875rem] text-text-muted">
                    {item.folder || "Vault root"}
                  </span>
                </button>
              )}
            </For>
          </Show>
        </div>
      </Show>

      <Show when={attachedFiles().length > 0}>
        <div class="flex flex-wrap gap-1 px-3 pt-2">
          <For each={attachedFiles()}>
            {(file) => (
              <span class="inline-flex max-w-full items-center gap-1 rounded-xs border border-border bg-bg-primary px-2 py-1 text-[0.6875rem] text-text-secondary">
                <span class="truncate" title={file.path}>
                  @{file.name}
                </span>
                <button
                  type="button"
                  class="text-text-muted transition-colors hover:text-text-primary disabled:opacity-40"
                  disabled={isLocked()}
                  aria-label={`Remove ${file.name}`}
                  onClick={() => removeFileAttachment(file.path)}
                >
                  x
                </button>
              </span>
            )}
          </For>
        </div>
      </Show>

      <textarea
        ref={textareaRef}
        rows={3}
        value={draft()}
        placeholder={
          chatState.selectedMode === "agent"
            ? " Ask the assistant to search, create or edit notes..."
            : " Ask a question about the vault..."
        }
        class="w-full resize-none bg-transparent px-3 pt-2.5 pb-1.5 text-sm text-text-primary outline-none placeholder:text-text-placeholder"
        disabled={isLocked()}
        onInput={(event) => {
          updateDraft(event.currentTarget.value);
        }}
        onKeyDown={handleKeyDown}
        onClick={refreshFileMention}
        onKeyUp={handleKeyUp}
      />
      {/* Footer */}
      <div class="flex items-center justify-between px-2 pb-2">
        {/* Left: mode selector + auto-approve */}
        <div class="flex items-center gap-1">
          <div class="relative">
            <button
              type="button"
              class="flex items-center gap-1 rounded-xs px-2 py-1 text-xs text-text-secondary transition-colors hover:bg-ghost-hover hover:text-text-primary"
              onClick={() => setShowModeMenu(!showModeMenu())}
            >
              <span class="capitalize">{chatState.selectedMode}</span>
              <svg
                width="10"
                height="10"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
              >
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
            <Show when={showModeMenu()}>
              <div
                class="absolute bottom-full left-0 z-50 mb-1 w-52 rounded-xs border border-border bg-bg-primary p-1 shadow-lg"
                onClick={() => setShowModeMenu(false)}
              >
                <For each={MODE_OPTIONS}>
                  {(opt) => (
                    <button
                      type="button"
                      class="flex w-full flex-col rounded-xs px-3 py-2 text-left transition-colors hover:bg-bg-elevated"
                      classList={{
                        "bg-ghost-hover": chatState.selectedMode === opt.value,
                      }}
                      onClick={() => void switchMode(opt.value)}
                    >
                      <span class="text-xs font-medium text-text-primary">{opt.title}</span>
                      <span class="text-[0.6875rem] text-text-muted">{opt.desc}</span>
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </div>

          <Show when={chatState.selectedMode === "agent" && session()}>
            {(current) => (
              <label
                class="flex cursor-pointer items-center gap-1.5 rounded-xs px-1.5 py-1 text-[0.6875rem] transition-colors select-none"
                classList={{
                  "text-text-primary": current().autoApprove,
                  "text-text-muted hover:text-text-secondary": !current().autoApprove,
                }}
              >
                <input
                  type="checkbox"
                  class="accent-text-primary"
                  checked={current().autoApprove}
                  onChange={(e) => setAutoApprove(current().id, e.currentTarget.checked)}
                />
                Auto-approve
              </label>
            )}
          </Show>
        </div>

        {/* Right: send / stop */}
        <div class="flex items-center gap-1">
          <Show
            when={isBusy()}
            fallback={
              <button
                type="button"
                disabled={isLocked() || !draft().trim()}
                class="flex size-7 items-center justify-center rounded-xs bg-text-primary text-bg-primary transition-opacity hover:opacity-80 disabled:opacity-30"
                title="Send"
                onClick={() => void submit()}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                >
                  <path d="M12 19V5M5 12l7-7 7 7" />
                </svg>
              </button>
            }
          >
            <button
              type="button"
              class="flex size-7 items-center justify-center rounded-xs bg-error/15 text-error transition-colors hover:bg-error/25"
              title="Stop"
              onClick={() => void cancelSession()}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                <rect x="4" y="4" width="16" height="16" rx="2" />
              </svg>
            </button>
          </Show>
        </div>
      </div>
    </div>
  );
}

export { ChatInput };
