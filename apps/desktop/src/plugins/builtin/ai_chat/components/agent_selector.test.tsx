import { renderToString } from "solid-js/web";
import { describe, expect, it, vi } from "vitest";

import { AgentSelector } from "./agent_selector";

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

describe("AgentSelector", () => {
  it("renders only the active native agent and Codex external agent", () => {
    const html = renderToString(() => <AgentSelector />);

    expect(html).toContain("Kuku Agent");
    expect(html).toContain("External Agents");
    expect(html).toContain("Codex CLI");
    expect(html).not.toContain("Claude Agent");
    expect(html).not.toContain("Gemini CLI");
    expect(html).not.toContain("Add More Agents");
    expect(html).toContain("disabled");
    expect(html).toContain('aria-label="Select AI agent"');
  });
});
