import { renderToString } from "solid-js/web";
import { describe, expect, it, vi } from "vitest";

import type { ChatSessionSummary } from "../types";
import { ChatSessionMenu } from "./chat_session_menu";

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

const summaries: ChatSessionSummary[] = [
  {
    id: "session-1",
    agentId: "kuku-native",
    mode: "ask",
    title: "첫 번째 세션",
    draft: "",
    messageCount: 2,
    status: "idle",
    isActive: true,
    updatedAt: 1,
  },
  {
    id: "session-2",
    agentId: "codex-acp",
    mode: "agent",
    title: "두 번째 세션",
    draft: "",
    messageCount: 5,
    status: "idle",
    isActive: false,
    updatedAt: 2,
  },
];

describe("ChatSessionMenu", () => {
  it("renders the active session as a menu trigger", () => {
    const html = renderToString(() => (
      <ChatSessionMenu items={summaries} activeSessionId="session-1" />
    ));

    expect(html).toContain('data-kuku-session-switcher="true"');
    expect(html).toContain('aria-label="Switch chat session"');
    expect(html).toContain("첫 번째 세션");
    expect(html).not.toContain("<select");
  });

  it("renders switchable sessions inside the open menu", () => {
    const html = renderToString(() => (
      <ChatSessionMenu items={summaries} activeSessionId="session-1" defaultOpen />
    ));

    expect(html).toContain('data-kuku-session-menu="true"');
    expect(html).toContain('data-kuku-menu-popover="true"');
    expect(html).toContain('data-kuku-session-menu-item="session-1"');
    expect(html).toContain('data-kuku-session-menu-item="session-2"');
    expect(html).toContain("max-h-[min(18rem,calc(100vh-4rem))]");
    expect(html).toContain('aria-current="true"');
    expect(html).not.toContain("messageCount");
  });
});
