import { describe, expect, it } from "vitest";

import {
  getKnowledgeEditorApplyState,
  getVisibleKnowledgeEditorApplyState,
  resetKnowledgeEditorApplyState,
  setKnowledgeEditorApplying,
  setKnowledgeEditorApplyError,
} from "./editor_apply_state";

describe("knowledge editor apply state", () => {
  it("scopes apply state by decision document path", () => {
    resetKnowledgeEditorApplyState();

    setKnowledgeEditorApplying("Knowledge/decisions/a.md");

    expect(getKnowledgeEditorApplyState("Knowledge/decisions/a.md").status).toBe("applying");
    expect(getKnowledgeEditorApplyState("Knowledge/decisions/b.md").status).toBe("idle");
  });

  it("resets one decision document without clearing another", () => {
    resetKnowledgeEditorApplyState();

    setKnowledgeEditorApplying("Knowledge/decisions/a.md");
    setKnowledgeEditorApplyError("Knowledge/decisions/b.md", {
      code: "VALIDATION_FAILED",
      message: "Invalid",
    });
    resetKnowledgeEditorApplyState("Knowledge/decisions/a.md");

    expect(getKnowledgeEditorApplyState("Knowledge/decisions/a.md").status).toBe("idle");
    expect(getKnowledgeEditorApplyState("Knowledge/decisions/b.md").status).toBe("error");
  });

  it("keeps the latest apply state visible when the editor path is temporarily unavailable", () => {
    resetKnowledgeEditorApplyState();

    setKnowledgeEditorApplyError("Knowledge/decisions/a.md", {
      code: "DOCUMENT_CHANGED",
      message: "Wiki page changed before apply: Knowledge/wiki/concepts/auth.md",
    });

    expect(getKnowledgeEditorApplyState("Knowledge/decisions/b.md").status).toBe("idle");
    expect(getVisibleKnowledgeEditorApplyState("Knowledge/decisions/b.md").status).toBe("idle");
    expect(getVisibleKnowledgeEditorApplyState(null).status).toBe("error");

    resetKnowledgeEditorApplyState("Knowledge/decisions/a.md");

    expect(getVisibleKnowledgeEditorApplyState(null).status).toBe("idle");
  });
});
