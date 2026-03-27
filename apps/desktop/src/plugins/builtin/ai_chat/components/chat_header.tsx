import { Show, type JSX } from "solid-js";

import {
  cancelSession,
  chatState,
  createSession,
  getActiveSession,
  isSessionBusy,
  setAutoApprove,
} from "../chat_store";
import type { ChatSessionState } from "../types";
import { getSessionStatusMeta, type ChatUiTone } from "../ui_state";

const STATUS_TONE_CLASSES: Record<ChatUiTone, string> = {
  neutral: "text-text-muted",
  accent: "text-info",
  warning: "text-warning",
  danger: "text-error",
  success: "text-success",
} as const;

function ChatHeader(): JSX.Element {
  const session = (): ChatSessionState | null => {
    const id = chatState.activeSessionId;
    return id ? (chatState.sessions[id] ?? null) : null;
  };
  const statusMeta = () => getSessionStatusMeta(session());
  const canCancel = () => isSessionBusy(session());
  const isAgent = () => session()?.mode === "agent";

  return (
    <div class="flex h-10 shrink-0 items-center justify-between border-b border-border px-3">
      {/* Left: status */}
      <div class="flex items-center gap-2 text-xs">
        <span class={STATUS_TONE_CLASSES[statusMeta().tone]}>{statusMeta().label}</span>
        <Show when={isAgent() && session()}>
          {(current) => (
            <label class="flex cursor-pointer items-center gap-1.5 text-[0.6875rem] text-text-muted select-none">
              <input
                type="checkbox"
                class="accent-info"
                checked={current().autoApprove}
                onChange={(e) => setAutoApprove(current().id, e.currentTarget.checked)}
              />
              Auto
            </label>
          )}
        </Show>
      </div>

      {/* Right: actions */}
      <div class="flex items-center gap-1">
        <Show when={canCancel()}>
          <button
            type="button"
            class="flex size-7 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-ghost-hover hover:text-text-secondary"
            title="Cancel"
            onClick={() => void cancelSession()}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none">
              <rect x="4" y="4" width="16" height="16" rx="2" />
            </svg>
          </button>
        </Show>

        <button
          type="button"
          class="flex size-7 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-ghost-hover hover:text-text-secondary"
          title="Clear Chat"
          disabled={chatState.isCreatingSession || isSessionBusy(session())}
          onClick={() => {
            const active = getActiveSession();
            if (!active) return;
            void createSession(chatState.selectedMode);
          }}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <path d="M3 6h18" />
            <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
            <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
          </svg>
        </button>
      </div>
    </div>
  );
}

export { ChatHeader };
