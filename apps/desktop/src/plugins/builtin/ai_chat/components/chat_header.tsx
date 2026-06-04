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
                canCloseSession={(item) => !isSessionBusy(chatState.sessions[item.id])}
                onCloseSession={(id) => void closeSession(id)}
              />
            </Show>

            <AgentSessionMenu align={visibleSessionSummaries().length > 0 ? "right" : "left"} />
          </div>
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
