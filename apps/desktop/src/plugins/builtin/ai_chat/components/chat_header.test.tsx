import { renderToString } from "solid-js/web";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { resetChatState, resetToSession, setSessionStatus } from "../chat_store";
import { ChatHeader } from "./chat_header";

vi.mock("~/plugins/context_keys", () => ({
  setContextKey: vi.fn(),
}));

vi.mock("../approval_diff", () => ({
  openApprovalDiff: vi.fn(),
}));

vi.mock("../context_snapshot", () => ({
  createContextSnapshotSource: () => ({
    snapshot: () => ({
      activeFile: null,
      selectedText: null,
      openTabs: [],
      cursorLine: null,
    }),
  }),
}));

vi.mock("../responding_state", () => ({
  hasRespondingSession: () => false,
}));

describe("ChatHeader", () => {
  beforeEach(() => {
    resetChatState();
  });

  it("renders session switching and creation without a separate close group", () => {
    resetToSession("ask-session", "ask");
    resetToSession("agent-session", "agent");

    const html = renderToString(() => <ChatHeader />);
    const primaryIndex = html.indexOf('data-kuku-session-primary-controls="true"');
    const switcherIndex = html.indexOf('data-kuku-session-switcher="true"');
    const newSessionIndex = html.indexOf('data-kuku-new-chat-session="true"');

    expect(primaryIndex).toBeGreaterThan(-1);
    expect(switcherIndex).toBeGreaterThan(primaryIndex);
    expect(newSessionIndex).toBeGreaterThan(switcherIndex);
    expect(html).not.toContain('data-kuku-session-close-controls="true"');
    expect(html).not.toContain('data-kuku-close-chat-session="true"');
    expect(html).not.toContain("<select");
  });

  it("renders header actions without the session status indicator", () => {
    resetToSession("ask-session", "ask");

    const html = renderToString(() => <ChatHeader />);

    expect(html).toContain('aria-label="New session"');
    expect(html).not.toContain('aria-label="Close session"');
    expect(html).not.toContain('data-kuku-session-status-indicator="true"');
    expect(html).not.toContain('role="status"');
  });

  it("does not render a top-level cancel action while the session is busy", () => {
    resetToSession("ask-session", "ask");
    setSessionStatus("ask-session", "streaming");

    const html = renderToString(() => <ChatHeader />);

    expect(html).not.toContain('data-kuku-chat-stop-button="true"');
    expect(html).not.toContain('title="Cancel"');
  });
});
