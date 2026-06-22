import { Show, type JSX } from "solid-js";

import {
  cancelSession,
  chatState,
  createSession,
  getActiveSession,
  isSessionBusy,
} from "../chat_store";
import { scopeTitle } from "../folder_scope";
import type { ChatSessionState } from "../types";
import { getSessionStatusMeta, type ChatUiTone } from "../ui_state";
import { t } from "~/i18n";

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

  return (
    <div class="flex h-10 shrink-0 items-center justify-between border-b border-border bg-bg-primary px-3">
      {/* Left: status */}
      <div class="flex min-w-0 items-center gap-2">
        <span class="size-1.5 shrink-0 rounded-full bg-text-muted/30" aria-hidden="true" />
        <span
          class={`text-[0.6875rem] font-medium tracking-wide ${STATUS_TONE_CLASSES[statusMeta().tone]}`}
        >
          {statusMeta().label}
        </span>
        <span class="max-w-32 truncate rounded-sm border border-border/50 bg-bg-secondary px-1.5 py-0.5 text-[0.625rem] font-medium text-text-muted">
          {scopeTitle(chatState.selectedScope)}
        </span>
      </div>

      {/* Right: actions */}
      <div class="flex items-center gap-0.5">
        <Show when={canCancel()}>
          <button
            type="button"
            class="flex size-8 items-center justify-center rounded-md text-text-muted transition hover:bg-ghost-hover hover:text-text-primary"
            title={t("chat.header.cancel")}
            onClick={() => void cancelSession()}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none">
              <rect x="4" y="4" width="16" height="16" rx="2" />
            </svg>
          </button>
        </Show>

        <button
          type="button"
          class="flex size-8 items-center justify-center rounded-md text-text-muted transition enabled:hover:bg-ghost-hover enabled:hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
          title={t("chat.header.clear")}
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
