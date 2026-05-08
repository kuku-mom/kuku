import { createStore, reconcile } from "solid-js/store";

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

const [knowledgeEditorApplyStore, setKnowledgeEditorApplyStore] =
  createStore<KnowledgeEditorApplyStore>({
    byPath: {},
    global: makeIdleState(),
  });
let byPathState: Record<string, KnowledgeEditorApplyState> = {};

function getKnowledgeEditorApplyState(path: string | null | undefined): KnowledgeEditorApplyState {
  if (!path) return knowledgeEditorApplyStore.global;
  return byPathState[normalizePath(path)] ?? makeIdleState();
}

function getVisibleKnowledgeEditorApplyState(
  path: string | null | undefined,
): KnowledgeEditorApplyState {
  const scoped = getKnowledgeEditorApplyState(path);
  if (scoped.status !== "idle") return scoped;
  return path ? scoped : knowledgeEditorApplyStore.global;
}

function resetKnowledgeEditorApplyState(path?: string | null): void {
  if (!path) {
    byPathState = {};
    setKnowledgeEditorApplyStore("byPath", reconcile({}));
    setKnowledgeEditorApplyStore("global", makeIdleState());
    return;
  }
  setPathApplyState(path, makeIdleState());
  if (isSameStatePath(knowledgeEditorApplyStore.global, path)) {
    setKnowledgeEditorApplyStore("global", makeIdleState());
  }
}

function setKnowledgeEditorApplying(path: string): void {
  const state: KnowledgeEditorApplyState = { status: "applying", path };
  setPathApplyState(path, state);
  setKnowledgeEditorApplyStore("global", state);
}

function setKnowledgeEditorApplyResult(path: string, result: ApplyDecisionDocumentResult): void {
  const state: KnowledgeEditorApplyState = { status: "applied", path, result };
  setPathApplyState(path, state);
  setKnowledgeEditorApplyStore("global", state);
}

function setKnowledgeEditorApplyError(path: string | null, error: KnowledgeError): void {
  const state: KnowledgeEditorApplyState = { status: "error", path, error };
  if (!path) {
    setKnowledgeEditorApplyStore("global", state);
    return;
  }
  setPathApplyState(path, state);
  setKnowledgeEditorApplyStore("global", state);
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

function makeIdleState(): KnowledgeEditorApplyState {
  return { status: "idle", path: null };
}

function setPathApplyState(path: string, state: KnowledgeEditorApplyState): void {
  byPathState = {
    ...byPathState,
    [normalizePath(path)]: state,
  };
  setKnowledgeEditorApplyStore("byPath", reconcile(byPathState));
}

function isSameStatePath(state: KnowledgeEditorApplyState, path: string): boolean {
  return state.path !== null && normalizePath(state.path) === normalizePath(path);
}

export {
  getKnowledgeEditorApplyState,
  getVisibleKnowledgeEditorApplyState,
  knowledgeEditorApplyStore,
  resetKnowledgeEditorApplyState,
  setKnowledgeEditorApplying,
  setKnowledgeEditorApplyError,
  setKnowledgeEditorApplyResult,
};
export type { KnowledgeEditorApplyState };
