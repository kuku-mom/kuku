import { beforeAll, describe, expect, it, vi } from "vitest";
import type * as EditorApply from "./editor_apply";

let editorApply: typeof EditorApply;

beforeAll(async () => {
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
  });
  editorApply = await import("./editor_apply");
});

describe("knowledge editor apply", () => {
  it("recognizes decision document paths only", () => {
    expect(editorApply.isKnowledgeDecisionDocumentPath("Knowledge/decisions/doc_auth.md")).toBe(
      true,
    );
    expect(editorApply.isKnowledgeDecisionDocumentPath("knowledge/decisions/doc_auth.md")).toBe(
      true,
    );
    expect(editorApply.isKnowledgeDecisionDocumentPath("Knowledge/memory/mem_auth.md")).toBe(false);
    expect(editorApply.isKnowledgeDecisionDocumentPath("Notes/doc_auth.md")).toBe(false);
  });

  it("saves the editor document and applies with the saved checksum", async () => {
    const calls: string[] = [];
    const result = await editorApply.saveAndApplyDecisionDocument({
      path: "Knowledge/decisions/doc_auth.md",
      saveDocument: async () => {
        calls.push("save");
        return { status: "saved", checksum: "vault-after", content: "abc" };
      },
      applyDecisionDocument: async (request) => {
        calls.push(`apply:${request.path}:${request.expected_checksum}:${request.source}`);
        return {
          ok: true,
          value: {
            doc_id: "doc_auth",
            path: request.path,
            status: "applied",
            committed_memory_paths: ["Knowledge/memory/mem_auth.md"],
            rejected_decision_ids: [],
            needs_revision_decision_ids: [],
            recovered_from_journal: false,
            warnings: [],
          },
        };
      },
    });

    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      "save",
      "apply:Knowledge/decisions/doc_auth.md:sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad:editor_document_apply",
    ]);
  });

  it("computes knowledge apply checksums with the sha256 prefix", async () => {
    await expect(editorApply.sha256ChecksumForText("abc")).resolves.toBe(
      "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("returns DOCUMENT_CHANGED when editor save conflicts", async () => {
    const result = await editorApply.saveAndApplyDecisionDocument({
      path: "Knowledge/decisions/doc_auth.md",
      saveDocument: async () => ({
        status: "conflict",
        expected: "sha256:before",
        actual: "sha256:external",
      }),
      applyDecisionDocument: async () => {
        throw new Error("apply should not run");
      },
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "DOCUMENT_CHANGED",
        message: "Document changed before apply",
        details: {
          expected_checksum: "sha256:before",
          actual_checksum: "sha256:external",
        },
      },
    });
  });

  it("does not apply when editor save cannot provide a checksum", async () => {
    const result = await editorApply.saveAndApplyDecisionDocument({
      path: "Knowledge/decisions/doc_auth.md",
      saveDocument: async () => ({ status: "skipped", reason: "missing-checksum" }),
      applyDecisionDocument: async () => {
        throw new Error("apply should not run");
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("DOCUMENT_CHANGED");
    }
  });
});
