import { renderToString } from "solid-js/web";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { resetChatState, resetToSession } from "../chat_store";
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

  it("renders session switching, creation, and close actions as separate groups", () => {
    resetToSession("ask-session", "ask");
    resetToSession("agent-session", "agent");

    const html = renderToString(() => <ChatHeader />);
    const primaryIndex = html.indexOf('data-kuku-session-primary-controls="true"');
    const switcherIndex = html.indexOf('data-kuku-session-switcher="true"');
    const newSessionIndex = html.indexOf('data-kuku-new-chat-session="true"');
    const closeGroupIndex = html.indexOf('data-kuku-session-close-controls="true"');
    const closeIndex = html.indexOf('data-kuku-close-chat-session="true"');

    expect(primaryIndex).toBeGreaterThan(-1);
    expect(switcherIndex).toBeGreaterThan(primaryIndex);
    expect(newSessionIndex).toBeGreaterThan(switcherIndex);
    expect(closeGroupIndex).toBeGreaterThan(newSessionIndex);
    expect(closeIndex).toBeGreaterThan(closeGroupIndex);
    expect(html).not.toContain("<select");
  });
});
