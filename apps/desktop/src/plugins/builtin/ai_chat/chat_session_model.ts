import type { ChatMessage, ChatSessionState, ChatSessionSummary, ChatTextMessage } from "./types";

type RuntimeChatMessage =
  | { kind: "system"; content: string }
  | { kind: "user"; content: string }
  | { kind: "assistant"; content: string; toolCalls?: [] }
  | {
      kind: "toolResult";
      callId: string;
      toolName: string;
      output: string;
      isError: boolean;
    };

function sessionTitle(session: ChatSessionState): string {
  const firstUserMessage = session.messages.find(
    (message): message is ChatTextMessage => message.kind === "text" && message.role === "user",
  );
  const title = firstUserMessage?.content.trim();
  if (title) {
    return title.length > 64 ? `${title.slice(0, 61)}...` : title;
  }

  if (session.persistedTitle?.trim()) {
    return session.persistedTitle.length > 64
      ? `${session.persistedTitle.slice(0, 61)}...`
      : session.persistedTitle;
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

function summarizeChatSessions(
  sessions: ChatSessionState[],
  activeSessionId: string | null,
): ChatSessionSummary[] {
  return sessions
    .map((session) => ({
      id: session.id,
      agentId: session.agentId,
      mode: session.mode,
      title: sessionTitle(session),
      draft: session.draft,
      messageCount: session.messages.length,
      status: session.status,
      isActive: activeSessionId === session.id,
      updatedAt: session.updatedAt,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function runtimeMessagesFromChatMessages(messages: ChatMessage[]): RuntimeChatMessage[] {
  return messages.flatMap((message): RuntimeChatMessage[] => {
    if (message.kind === "text") {
      switch (message.role) {
        case "system":
          return [{ kind: "system", content: message.content }];
        case "user":
          return [{ kind: "user", content: message.content }];
        case "assistant":
          return [{ kind: "assistant", content: message.content, toolCalls: [] }];
      }
    }

    if (message.kind === "tool") {
      const output = message.output ?? message.error;
      if (output == null) return [];
      return [
        {
          kind: "toolResult",
          callId: message.callId,
          toolName: message.toolName,
          output,
          isError: message.success === false || message.error != null,
        },
      ];
    }

    return [];
  });
}

function buildLegacyAcpHandoffPrompt(session: ChatSessionState): string | null {
  const transcript = session.messages
    .flatMap((message) => {
      if (message.kind !== "text") return [];
      const content = message.content.trim();
      if (!content) return [];
      return `${message.role.toUpperCase()}: ${content}`;
    })
    .join("\n\n")
    .trim();
  if (!transcript) return null;

  const maxLength = 12_000;
  const clippedTranscript =
    transcript.length > maxLength ? transcript.slice(transcript.length - maxLength) : transcript;

  return [
    "You are continuing a Kuku chat whose external ACP session could not be reattached.",
    "Use the prior local transcript below as conversation context. Do not mention this handoff unless the user asks.",
    "",
    "<previous_transcript>",
    clippedTranscript,
    "</previous_transcript>",
  ].join("\n");
}

export {
  buildLegacyAcpHandoffPrompt,
  runtimeMessagesFromChatMessages,
  sessionTitle,
  summarizeChatSessions,
};

export type { RuntimeChatMessage };
