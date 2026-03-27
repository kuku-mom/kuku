import { createEffect, createSignal, For, Show, type JSX } from "solid-js";

import {
  chatState,
  isSessionBusy,
  cancelSession,
  sendMessage,
  setDraft,
  switchMode,
} from "../chat_store";
import type { ChatMode } from "../types";

const MODE_OPTIONS: { value: ChatMode; title: string; desc: string }[] = [
  { value: "agent", title: "Agent", desc: "Search, edit and create notes" },
  { value: "ask", title: "Ask", desc: "Answer questions only" },
  { value: "inline", title: "Inline", desc: "Inline editing assistance" },
];

function ChatInput(): JSX.Element {
  const [draft, setLocalDraft] = createSignal("");
  const [showModeMenu, setShowModeMenu] = createSignal(false);

  const session = () =>
    chatState.activeSessionId ? (chatState.sessions[chatState.activeSessionId] ?? null) : null;
  const isLocked = () =>
    chatState.isCreatingSession ||
    chatState.isSendingMessage ||
    (session()?.status ?? "idle") !== "idle";
  const isBusy = () => isSessionBusy(session());

  createEffect(() => {
    const activeId = chatState.activeSessionId;
    if (!activeId) {
      setLocalDraft("");
      return;
    }
    setLocalDraft(chatState.sessions[activeId]?.draft ?? "");
  });

  async function submit(): Promise<void> {
    const value = draft();
    if (!value.trim()) return;
    await sendMessage(value);
    setLocalDraft("");
  }

  function handleKeyDown(e: KeyboardEvent): void {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  }

  return (
    <div class="border-y border-border bg-bg-secondary transition-colors focus-within:border-border-focused">
      <textarea
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
          const value = event.currentTarget.value;
          setLocalDraft(value);
          setDraft(value);
        }}
        onKeyDown={handleKeyDown}
      />
      {/* Footer */}
      <div class="flex items-center justify-between px-2 pb-2">
        {/* Left: mode selector */}
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
              class="absolute bottom-full left-0 z-50 mb-1 w-52 rounded-xs border border-border bg-bg-elevated p-1 shadow-lg"
              onClick={() => setShowModeMenu(false)}
            >
              <For each={MODE_OPTIONS}>
                {(opt) => (
                  <button
                    type="button"
                    class="flex w-full flex-col rounded-xs px-3 py-2 text-left transition-colors hover:bg-ghost-hover"
                    classList={{
                      "bg-ghost-selected": chatState.selectedMode === opt.value,
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

        {/* Right: send / stop */}
        <div class="flex items-center gap-1">
          <Show
            when={isBusy()}
            fallback={
              <button
                type="button"
                disabled={isLocked() || !draft().trim()}
                class="flex size-7 items-center justify-center rounded-md bg-text-primary text-bg-primary transition-opacity hover:opacity-80 disabled:opacity-30"
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
              class="flex size-7 items-center justify-center rounded-md bg-error/15 text-error transition-colors hover:bg-error/25"
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
