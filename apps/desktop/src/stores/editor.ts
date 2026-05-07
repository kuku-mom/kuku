import { createStore } from "solid-js/store";

import type { Disposer } from "~/plugins/types";

interface EditorState {
  tabId: string | null;
  filePath: string | null;
  checksum: string | null;
  isDirty: boolean;
  isLoading: boolean;
}

type EditorSaveResult =
  | { status: "saved"; checksum: string; content: string }
  | { status: "skipped"; reason: "diff" | "not-ready" | "missing-checksum" | "disposed" }
  | { status: "conflict"; expected: string; actual: string }
  | { status: "error"; message: string };

interface EditorDocumentSession {
  tabId: string;
  filePath: string;
  save(): Promise<EditorSaveResult>;
  reloadFromDisk(): Promise<EditorSaveResult>;
  getChecksum(): string | null;
}

const [editorState, setEditorState] = createStore<EditorState>({
  tabId: null,
  filePath: null,
  checksum: null,
  isDirty: false,
  isLoading: false,
});

let activeDocumentSession: EditorDocumentSession | null = null;

function registerEditorDocumentSession(session: EditorDocumentSession): Disposer {
  activeDocumentSession = session;
  return () => {
    if (activeDocumentSession === session) {
      activeDocumentSession = null;
    }
  };
}

function getEditorDocumentSession(path?: string | null): EditorDocumentSession | null {
  if (!activeDocumentSession) return null;
  if (path && normalizePath(activeDocumentSession.filePath) !== normalizePath(path)) {
    return null;
  }
  return activeDocumentSession;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

function resetEditorState(): void {
  setEditorState({
    tabId: null,
    filePath: null,
    checksum: null,
    isDirty: false,
    isLoading: false,
  });
}

export {
  editorState,
  getEditorDocumentSession,
  registerEditorDocumentSession,
  resetEditorState,
  setEditorState,
};
export type { EditorDocumentSession, EditorSaveResult, EditorState };
