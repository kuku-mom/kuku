import { describe, expect, it } from "vitest";

import {
  buildLegacyAcpHandoffPrompt,
  runtimeMessagesFromChatMessages,
  summarizeChatSessions,
} from "./chat_session_model";
import type { ChatSessionState } from "./types";

function session(overrides: Partial<ChatSessionState>): ChatSessionState {
  return {
    id: "session-1",
    agentId: "kuku-native",
    mode: "ask",
    createdAt: 1,
    updatedAt: 1,
    draft: "",
    fileAttachments: [],
    messages: [],
    inflightAssistantId: null,
    autoApprove: false,
    status: "idle",
    error: null,
    finishReason: null,
    ...overrides,
  };
}

describe("chat session model", () => {
  it("summarizes sessions with derived titles and active state", () => {
    const summaries = summarizeChatSessions(
      [
        session({
          id: "older",
          mode: "ask",
          updatedAt: 10,
          messages: [{ id: "message-1", kind: "text", role: "user", content: "Ask this" }],
        }),
        session({
          id: "newer",
          mode: "agent",
          updatedAt: 20,
          draft: "continue",
          messages: [],
        }),
      ],
      "newer",
    );

    expect(summaries).toMatchObject([
      {
        id: "newer",
        title: "Agent session",
        draft: "continue",
        isActive: true,
      },
      {
        id: "older",
        title: "Ask this",
        isActive: false,
      },
    ]);
  });

  it("converts stored chat messages into restore payload runtime messages", () => {
    expect(
      runtimeMessagesFromChatMessages([
        { id: "user", kind: "text", role: "user", content: "question" },
        { id: "assistant", kind: "text", role: "assistant", content: "answer" },
        {
          id: "tool",
          kind: "tool",
          callId: "call-1",
          toolName: "search",
          arguments: {},
          expanded: false,
          output: "result",
          success: true,
        },
      ]),
    ).toMatchObject([
      { kind: "user", content: "question" },
      { kind: "assistant", content: "answer", toolCalls: [] },
      { kind: "toolResult", callId: "call-1", toolName: "search", output: "result" },
    ]);
  });

  it("builds a bounded handoff prompt for legacy acp sessions", () => {
    const prompt = buildLegacyAcpHandoffPrompt(
      session({
        messages: [
          { id: "user", kind: "text", role: "user", content: "where were we?" },
          { id: "assistant", kind: "text", role: "assistant", content: "in the vault" },
        ],
      }),
    );

    expect(prompt).toContain("<previous_transcript>");
    expect(prompt).toContain("USER: where were we?");
    expect(prompt).toContain("ASSISTANT: in the vault");
  });
});
