import { createStore } from "solid-js/store";

import type { ApplyDecisionDocumentResult, KnowledgeError } from "./types";

type KnowledgeEditorApplyState =
  | { status: "idle"; path: null }
  | { status: "applying"; path: string }
  | { status: "applied"; path: string; result: ApplyDecisionDocumentResult }
  | { status: "error"; path: string | null; error: KnowledgeError };

interface KnowledgeEditorApplyStore {
  byPath: Record<string, KnowledgeEditorApplyState>;
  global: KnowledgeEditorApplyState;
}

const idleState: KnowledgeEditorApplyState = { status: "idle", path: null };

const [knowledgeEditorApplyStore, setKnowledgeEditorApplyStore] =
  createStore<KnowledgeEditorApplyStore>({
    byPath: {},
    global: idleState,
  });

function getKnowledgeEditorApplyState(path: string | null | undefined): KnowledgeEditorApplyState {
  if (!path) return knowledgeEditorApplyStore.global;
  return knowledgeEditorApplyStore.byPath[normalizePath(path)] ?? idleState;
}

function resetKnowledgeEditorApplyState(path?: string | null): void {
  if (!path) {
    setKnowledgeEditorApplyStore({ byPath: {}, global: idleState });
    return;
  }
  setKnowledgeEditorApplyStore("byPath", normalizePath(path), idleState);
}

function setKnowledgeEditorApplying(path: string): void {
  setKnowledgeEditorApplyStore("byPath", normalizePath(path), { status: "applying", path });
}

function setKnowledgeEditorApplyResult(path: string, result: ApplyDecisionDocumentResult): void {
  setKnowledgeEditorApplyStore("byPath", normalizePath(path), { status: "applied", path, result });
}

function setKnowledgeEditorApplyError(path: string | null, error: KnowledgeError): void {
  const state: KnowledgeEditorApplyState = { status: "error", path, error };
  if (!path) {
    setKnowledgeEditorApplyStore("global", state);
    return;
  }
  setKnowledgeEditorApplyStore("byPath", normalizePath(path), state);
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

export {
  getKnowledgeEditorApplyState,
  knowledgeEditorApplyStore,
  resetKnowledgeEditorApplyState,
  setKnowledgeEditorApplying,
  setKnowledgeEditorApplyError,
  setKnowledgeEditorApplyResult,
};
export type { KnowledgeEditorApplyState };
