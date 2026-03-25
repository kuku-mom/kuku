import { createEffect, type JSX } from "solid-js";

import { chatState } from "./chat_store";
import { ChatHeader } from "./components/chat_header";
import { ChatInput } from "./components/chat_input";
import { ChatMessages } from "./components/chat_messages";

function ChatPanel(): JSX.Element {
  let scrollHost: HTMLDivElement | undefined;

  createEffect(() => {
    const activeId = chatState.activeSessionId;
    const session = activeId ? (chatState.sessions[activeId] ?? null) : null;
    const messageCount = session?.messages.length ?? 0;
    if (!activeId || !scrollHost || messageCount === 0) return;
    requestAnimationFrame(() => {
      scrollHost?.scrollTo({ top: scrollHost.scrollHeight, behavior: "smooth" });
    });
  });

  return (
    <div class="flex h-full min-h-0 flex-col bg-bg-primary">
      <ChatHeader />
      <div ref={scrollHost} class="min-h-0 flex-1 overflow-auto">
        <ChatMessages />
      </div>
      <ChatInput />
    </div>
  );
}

export default ChatPanel;
