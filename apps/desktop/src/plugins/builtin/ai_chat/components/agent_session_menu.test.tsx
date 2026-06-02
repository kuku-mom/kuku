import { renderToString } from "solid-js/web";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { KUKU_NATIVE_AGENT_ID } from "../agent_catalog";
import { resetChatState, setChatAgents } from "../chat_store";
import { AgentSessionMenu } from "./agent_session_menu";

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

describe("AgentSessionMenu", () => {
  beforeEach(() => {
    resetChatState();
  });

  it("renders the new-session trigger as an agent picker", () => {
    const html = renderToString(() => <AgentSessionMenu />);

    expect(html).toContain('data-kuku-new-chat-session="true"');
    expect(html).toContain('aria-label="New session"');
    expect(html).not.toContain("<select");
  });

  it("renders enabled and disabled agents inside the open menu", () => {
    setChatAgents([
      {
        id: KUKU_NATIVE_AGENT_ID,
        label: "Kuku Agent",
        kind: "native",
        enabled: true,
        managed: true,
      },
      {
        id: "codex-acp",
        label: "Codex CLI",
        kind: "acp",
        enabled: false,
        managed: true,
      },
    ]);

    const html = renderToString(() => <AgentSessionMenu defaultOpen />);

    expect(html).toContain("Kuku Agent");
    expect(html).toContain("Codex CLI");
    expect(html).toContain("Not configured");
    expect(html).toContain("disabled");
  });
});
