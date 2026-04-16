import { describe, expect, it } from "vitest";

import type { ChatSessionState } from "./types";
import { hasRespondingSession, isRespondingStatus } from "./responding_state";

function createSession(status: ChatSessionState["status"]): ChatSessionState {
  return {
    id: `session-${status}`,
    mode: "agent",
    draft: "",
    fileAttachments: [],
    messages: [],
    inflightAssistantId: null,
    autoApprove: false,
    status,
    error: status === "error" ? "Boom" : null,
    finishReason: null,
  };
}

describe("ai_chat responding_state", () => {
  it("treats streaming and applying as responding", () => {
    expect(isRespondingStatus("streaming")).toBe(true);
    expect(isRespondingStatus("applying")).toBe(true);
  });

  it("treats idle, approval wait, and error as not responding", () => {
    expect(isRespondingStatus("idle")).toBe(false);
    expect(isRespondingStatus("awaiting-approval")).toBe(false);
    expect(isRespondingStatus("error")).toBe(false);
  });

  it("detects whether any session is currently responding", () => {
    expect(
      hasRespondingSession({
        idle: createSession("idle"),
        applying: createSession("applying"),
      }),
    ).toBe(true);

    expect(
      hasRespondingSession({
        idle: createSession("idle"),
        waiting: createSession("awaiting-approval"),
      }),
    ).toBe(false);
  });
});
