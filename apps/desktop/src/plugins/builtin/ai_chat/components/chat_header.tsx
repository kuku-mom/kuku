import { Show, type JSX } from "solid-js";

import {
  chatState,
  closeSession,
  getSessionSummaries,
  isSessionBusy,
} from "../chat_store";
import { AgentSessionMenu } from "./agent_session_menu";
import { ChatSessionMenu } from "./chat_session_menu";
import type { ChatSessionState, ChatSessionSummary } from "../types";
import { t } from "~/i18n";

function ChatHeader(): JSX.Element {
  const session = (): ChatSessionState | null => {
    const id = chatState.activeSessionId;
    return id ? (chatState.sessions[id] ?? null) : null;
  };
  const sessionSummaries = () => getSessionSummaries();
  const activeSessionSummary = (): ChatSessionSummary | null => {
    const active = session();
    if (!active) return null;
    return {
      id: active.id,
      agentId: active.agentId,
      mode: active.mode,
      title: active.persistedTitle?.trim() || fallbackSessionTitle(active),
      draft: active.draft,
      messageCount: active.messages.length,
      status: active.status,
      isActive: true,
      updatedAt: active.updatedAt,
    };
  };
  const visibleSessionSummaries = () => {
    const summaries = sessionSummaries();
    const active = activeSessionSummary();
    if (summaries.length > 0 || !active) return summaries;
    return [active];
  };

  return (
    <div class="flex h-10 shrink-0 items-center justify-between border-b border-border bg-bg-primary px-3">
      <div class="flex min-w-0 items-center">
        <div
          class="flex min-w-0 items-center gap-1"
          data-kuku-session-controls="true"
        >
          <div
            class="flex min-w-0 items-center gap-1"
            data-kuku-session-primary-controls="true"
          >
            <Show when={visibleSessionSummaries().length > 0}>
              <ChatSessionMenu
                items={visibleSessionSummaries()}
                activeSessionId={chatState.activeSessionId}
              />
            </Show>

            <AgentSessionMenu align={visibleSessionSummaries().length > 0 ? "right" : "left"} />
          </div>

          <Show when={session()}>
            <div
              class="ml-0.5 flex items-center border-l border-border pl-1"
              data-kuku-session-close-controls="true"
            >
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
            </div>
          </Show>
        </div>
      </div>
    </div>
  );
}

function fallbackSessionTitle(session: ChatSessionState): string {
  const firstUserMessage = session.messages.find(
    (message) => message.kind === "text" && message.role === "user",
  );
  const title = firstUserMessage?.content.trim();
  if (title) {
    return title.length > 64 ? `${title.slice(0, 61)}...` : title;
  }

  switch (session.mode) {
    case "agent":
      return "Agent session";
    case "inline":
      return "Inline session";
    case "ask":
      return "Ask session";
  }
}

export { ChatHeader };
