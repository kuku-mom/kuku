import { describe, expect, it } from "vitest";

import {
  deriveContextQuery,
  hasRecoveryWarning,
  isInboxDecisionStatus,
  parseApplyJournalSummary,
  parseDecisionDocumentSummary,
  parseMemorySummary,
  sortDecisionDocuments,
  sortRecentMemory,
} from "./knowledge_panel_data";

describe("knowledge panel data", () => {
  it("parses decision document summaries and missing required decisions", () => {
    const summary = parseDecisionDocumentSummary(
      "Knowledge/decisions/auth.md",
      `---
id: doc_auth
title: Auth Proposal
status: pending
updated_at: 2026-05-07T00:00:02Z
---

\`\`\`kuku-decision
id: decision_auth
required: true
status: pending
\`\`\`

\`\`\`kuku-decision
id: decision_done
required: true
status: pending
selected_option_id: yes
\`\`\`
`,
    );

    expect(summary).toMatchObject({
      path: "Knowledge/decisions/auth.md",
      title: "Auth Proposal",
      status: "pending",
      decisionCount: 2,
      missingRequiredCount: 1,
    });
  });

  it("parses recent memory metadata and tag arrays", () => {
    const summary = parseMemorySummary(
      "Knowledge/memory/mem_auth.md",
      `---
id: mem_auth
kind: decision
title: Session cookie first
status: active
tags:
- auth
- session
source_refs: []
created_at: 2026-05-07T00:00:00Z
updated_at: 2026-05-07T00:00:03Z
proposal_id: prop_auth
decision_document: Knowledge/decisions/auth.md
---
Use session cookies first.
`,
    );

    expect(summary).toMatchObject({
      id: "mem_auth",
      title: "Session cookie first",
      kind: "decision",
      tags: ["auth", "session"],
    });
  });

  it("parses apply journal warnings", () => {
    const journal = parseApplyJournalSummary(
      ".kuku/knowledge/apply-journal/doc_auth.json",
      JSON.stringify({
        doc_id: "doc_auth",
        decision_document_path: "Knowledge/decisions/auth.md",
        state: "cleanup_required",
        created_paths: ["Knowledge/memory/mem_auth.md"],
        updated_at: "2026-05-07T00:00:04Z",
        error: "cleanup failed",
      }),
    );

    expect(journal).toMatchObject({
      docId: "doc_auth",
      decisionDocumentPath: "Knowledge/decisions/auth.md",
      state: "cleanup_required",
      createdPaths: ["Knowledge/memory/mem_auth.md"],
    });
    if (!journal) {
      throw new Error("journal should parse");
    }
    expect(hasRecoveryWarning(journal)).toBe(true);
  });

  it("sorts inbox and recent memory deterministically", () => {
    expect(
      sortDecisionDocuments([
        {
          path: "Knowledge/decisions/b.md",
          title: "B",
          status: "pending",
          updatedAt: "2026-05-07T00:00:00Z",
          decisionCount: 1,
          missingRequiredCount: 0,
        },
        {
          path: "Knowledge/decisions/a.md",
          title: "A",
          status: "pending",
          updatedAt: "2026-05-07T00:00:00Z",
          decisionCount: 1,
          missingRequiredCount: 0,
        },
      ]).map((item) => item.path),
    ).toEqual(["Knowledge/decisions/a.md", "Knowledge/decisions/b.md"]);

    expect(
      sortRecentMemory([
        {
          path: "Knowledge/memory/old.md",
          id: "mem_old",
          title: "Old",
          status: "active",
          updatedAt: "2026-05-07T00:00:00Z",
          tags: [],
        },
        {
          path: "Knowledge/memory/new.md",
          id: "mem_new",
          title: "New",
          status: "active",
          updatedAt: "2026-05-07T00:00:01Z",
          tags: [],
        },
      ]).map((item) => item.id),
    ).toEqual(["mem_new", "mem_old"]);
  });

  it("classifies inbox statuses and derives active path context queries", () => {
    expect(isInboxDecisionStatus("pending")).toBe(true);
    expect(isInboxDecisionStatus("apply_failed")).toBe(true);
    expect(isInboxDecisionStatus("applied")).toBe(false);
    expect(deriveContextQuery("Projects/Auth/session-cookie.md")).toBe("session cookie");
  });
});
