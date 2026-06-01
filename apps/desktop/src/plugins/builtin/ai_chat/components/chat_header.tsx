import { For, Show, type JSX } from "solid-js";

import {
  cancelSession,
  chatState,
  closeSession,
  createSession,
  getSessionSummaries,
  isSessionBusy,
  switchSession,
} from "../chat_store";
import { AgentSelector } from "./agent_selector";
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
  const sessionSummaries = () => getSessionSummaries();

  return (
    <div class="flex h-10 shrink-0 items-center justify-between border-b border-border bg-bg-primary px-3">
      {/* Left: status */}
      <div class="flex min-w-0 items-center gap-2">
        <AgentSelector />
        <span class="size-1.5 shrink-0 rounded-full bg-text-muted/30" aria-hidden="true" />
        <span
          class={`text-[0.6875rem] font-medium tracking-wide ${STATUS_TONE_CLASSES[statusMeta().tone]}`}
        >
          {statusMeta().label}
        </span>
        <div
          class="ml-1 flex min-w-0 items-center gap-1 border-l border-border pl-2"
          data-kuku-session-controls="true"
        >
          <Show when={sessionSummaries().length > 0}>
            <select
              data-kuku-session-select="true"
              class="hover:border-border-strong h-7 max-w-[10rem] min-w-0 rounded-md border border-border bg-bg-secondary px-2 text-[0.6875rem] text-text-secondary transition outline-none focus:border-accent"
              value={chatState.activeSessionId ?? ""}
              title={t("chat.header.session_select")}
              aria-label={t("chat.header.session_select")}
              onChange={(event) => {
                switchSession(event.currentTarget.value);
              }}
            >
                  <For each={sessionSummaries()}>
                    {(item) => (
                      <option value={item.id}>{item.title}</option>
                    )}
                  </For>
            </select>
          </Show>

          <button
            type="button"
            data-kuku-new-chat-session="true"
            class="flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-bg-secondary text-text-secondary transition enabled:hover:border-border-strong enabled:hover:bg-ghost-hover enabled:hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
            title={t("chat.header.new_session")}
            aria-label={t("chat.header.new_session")}
            disabled={chatState.isCreatingSession || isSessionBusy(session())}
            onClick={() => {
              void createSession(chatState.selectedMode);
            }}
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
            >
              <path d="M12 5v14" />
              <path d="M5 12h14" />
            </svg>
          </button>

          <Show when={session()}>
            <button
              type="button"
              data-kuku-close-chat-session="true"
              class="flex size-7 shrink-0 items-center justify-center rounded-md text-text-muted transition enabled:hover:bg-ghost-hover enabled:hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
              title={t("chat.header.close_session")}
              aria-label={t("chat.header.close_session")}
              disabled={isSessionBusy(session())}
              onClick={() => void closeSession()}
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
              >
                <path d="M6 6l12 12" />
                <path d="M18 6L6 18" />
              </svg>
            </button>
          </Show>
        </div>
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

      </div>
    </div>
  );
}

export { ChatHeader };
