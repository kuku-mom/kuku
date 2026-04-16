import { describe, expect, it } from "vitest";

import type { ChatApprovalMessage, ChatSessionState, ChatToolMessage } from "./types";
import {
  getApprovalStatusLabel,
  getApprovalSummary,
  getSessionStatusMeta,
  getToolPreview,
  getToolStatusLabel,
  truncateSingleLine,
} from "./ui_state";

function createSession(status: ChatSessionState["status"]): ChatSessionState {
  return {
    id: "session-1",
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

function createToolMessage(overrides: Partial<ChatToolMessage> = {}): ChatToolMessage {
  return {
    id: "tool-1",
    kind: "tool",
    callId: "call-1",
    toolName: "read_file",
    arguments: { path: "notes/test.md" },
    expanded: false,
    ...overrides,
  };
}

function createApprovalMessage(overrides: Partial<ChatApprovalMessage> = {}): ChatApprovalMessage {
  return {
    id: "approval-1",
    kind: "approval",
    callId: "call-1",
    toolName: "edit_file",
    mutation: {
      summary: "Edit notes/test.md",
    },
    previewText: "Change the first line",
    expanded: false,
    status: "pending",
    ...overrides,
  };
}

describe("ai_chat ui_state", () => {
  it("maps session statuses to readable labels", () => {
    expect(getSessionStatusMeta(createSession("idle")).label).toBe("Idle");
    expect(getSessionStatusMeta(createSession("streaming")).label).toBe("Thinking");
    expect(getSessionStatusMeta(createSession("awaiting-approval")).label).toBe(
      "Waiting for approval",
    );
    expect(getSessionStatusMeta(createSession("applying")).label).toBe("Applying");
    expect(getSessionStatusMeta(createSession("error")).label).toBe("Error");
  });

  it("prefers tool output and errors when building previews", () => {
    expect(getToolStatusLabel(createToolMessage())).toBe("Running");
    expect(getToolPreview(createToolMessage({ output: "Line 1\nLine 2", success: true }))).toBe(
      "Line 1 Line 2",
    );
    expect(getToolStatusLabel(createToolMessage({ error: "Something failed" }))).toBe("Error");
  });

  it("summarizes approval rows from preview text and errors", () => {
    expect(getApprovalStatusLabel(createApprovalMessage({ status: "applied" }))).toBe("Applied");
    expect(getApprovalSummary(createApprovalMessage())).toBe("Change the first line");
    expect(
      getApprovalSummary(createApprovalMessage({ status: "error", error: "Conflict detected" })),
    ).toBe("Conflict detected");
  });

  it("truncates long single-line content", () => {
    expect(truncateSingleLine("a".repeat(120), 20)).toBe(`${"a".repeat(19)}…`);
  });
});
