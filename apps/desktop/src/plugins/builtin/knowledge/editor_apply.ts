import type { PluginContext } from "~/plugins/types";
import { getEditorDocumentSession, type EditorSaveResult } from "~/stores/editor";

import {
  setKnowledgeEditorApplying,
  setKnowledgeEditorApplyError,
  setKnowledgeEditorApplyResult,
} from "./editor_apply_state";
import type { KnowledgeService } from "./service";
import type {
  ApplyDecisionDocumentRequest,
  ApplyDecisionDocumentResult,
  KnowledgeCommandResult,
  KnowledgeError,
} from "./types";

interface SaveDecisionDocumentForApplyInput {
  path: string;
  saveDocument(): Promise<EditorSaveResult>;
}

interface SaveAndApplyDecisionDocumentInput extends SaveDecisionDocumentForApplyInput {
  applyDecisionDocument(
    request: ApplyDecisionDocumentRequest,
  ): Promise<KnowledgeCommandResult<ApplyDecisionDocumentResult>>;
}

function isKnowledgeDecisionDocumentPath(path: string | null | undefined): boolean {
  const normalized = path?.replace(/\\/g, "/").toLowerCase();
  return Boolean(normalized?.startsWith("knowledge/decisions/") && normalized.endsWith(".md"));
}

async function applyActiveDecisionDocument(
  ctx: PluginContext,
  service: KnowledgeService,
): Promise<void> {
  const path = ctx.editor.activeFilePath;
  if (!path || !isKnowledgeDecisionDocumentPath(path)) {
    setKnowledgeEditorApplyError(path, knowledgeError("INVALID_ARGUMENT", "No decision document"));
    return;
  }
  const decisionPath = path;

  const session = getEditorDocumentSession(decisionPath);
  if (!ctx.editor.instance || !session) {
    setKnowledgeEditorApplyError(path, knowledgeError("INVALID_ARGUMENT", "Editor is not ready"));
    return;
  }

  setKnowledgeEditorApplying(decisionPath);
  const result = await saveAndApplyDecisionDocument({
    path: decisionPath,
    saveDocument: () => session.save(),
    applyDecisionDocument: (request) => service.applyDecisionDocument(request),
  });

  if (result.ok) {
    await session.reloadFromDisk();
    setKnowledgeEditorApplyResult(decisionPath, result.value);
  } else {
    setKnowledgeEditorApplyError(decisionPath, result.error);
  }
}

async function saveAndApplyDecisionDocument(
  input: SaveAndApplyDecisionDocumentInput,
): Promise<KnowledgeCommandResult<ApplyDecisionDocumentResult>> {
  try {
    const saved = await saveDecisionDocumentForApply(input);
    if (!saved.ok) return saved;

    const expectedChecksum = await sha256ChecksumForText(saved.value.content);
    return input.applyDecisionDocument({
      path: input.path,
      expected_checksum: expectedChecksum,
      source: "editor_document_apply",
    });
  } catch (error) {
    return { ok: false, error: unknownToKnowledgeError(error) };
  }
}

async function saveDecisionDocumentForApply(
  input: SaveDecisionDocumentForApplyInput,
): Promise<KnowledgeCommandResult<{ content: string }>> {
  const result = await input.saveDocument();
  if (result.status === "saved") {
    return { ok: true, value: { content: result.content } };
  }
  if (result.status === "conflict") {
    return {
      ok: false,
      error: knowledgeError("DOCUMENT_CHANGED", "Document changed before apply", {
        expected_checksum: result.expected,
        actual_checksum: result.actual,
      }),
    };
  }
  if (result.status === "error") {
    return { ok: false, error: knowledgeError("IO_ERROR", result.message) };
  }
  return {
    ok: false,
    error: knowledgeError("DOCUMENT_CHANGED", `Document could not be saved: ${result.reason}`),
  };
}

function knowledgeError(
  code: KnowledgeError["code"],
  message: string,
  details?: Record<string, unknown>,
): KnowledgeError {
  return { code, message, ...(details ? { details } : {}) };
}

function unknownToKnowledgeError(error: unknown): KnowledgeError {
  return knowledgeError("IO_ERROR", error instanceof Error ? error.message : String(error));
}

async function sha256ChecksumForText(content: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(content),
  );
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
  return `sha256:${hex}`;
}

export {
  applyActiveDecisionDocument,
  isKnowledgeDecisionDocumentPath,
  saveAndApplyDecisionDocument,
  saveDecisionDocumentForApply,
  sha256ChecksumForText,
};
