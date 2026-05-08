import { describe, expect, it } from "vitest";

import { applyButtonLabel, formatApplyError } from "./components/kuku_decision_node";
import type { KnowledgeEditorApplyState } from "./editor_apply_state";

describe("kuku decision node apply feedback", () => {
  it("labels apply button with the current apply state", () => {
    expect(applyButtonLabel({ status: "idle", path: null })).toBe("Apply document");
    expect(
      applyButtonLabel({
        status: "applying",
        path: "Knowledge/decisions/a.md",
      }),
    ).toBe("Applying...");
    expect(
      applyButtonLabel({
        status: "error",
        path: "Knowledge/decisions/a.md",
        error: { code: "DOCUMENT_CHANGED", message: "Changed" },
      }),
    ).toBe("Apply failed");
  });

  it("explains stale wiki update proposals as a visible conflict", () => {
    expect(
      formatApplyError({
        code: "DOCUMENT_CHANGED",
        message: "Wiki page changed before apply: Knowledge/wiki/concepts/auth.md",
      }),
    ).toEqual({
      title: "Target wiki page changed",
      message:
        "This update proposal is based on an older wiki page. Read the current wiki page and create a fresh update proposal before applying.",
    });
  });

  it("keeps applied label stable", () => {
    const state: KnowledgeEditorApplyState = {
      status: "applied",
      path: "Knowledge/decisions/a.md",
      result: {
        doc_id: "doc_a",
        path: "Knowledge/decisions/a.md",
        status: "applied",
        committed_memory_paths: [],
        committed_wiki_paths: [],
        rejected_decision_ids: [],
        needs_revision_decision_ids: [],
        recovered_from_journal: false,
        warnings: [],
      },
    };

    expect(applyButtonLabel(state)).toBe("Applied");
  });
});
