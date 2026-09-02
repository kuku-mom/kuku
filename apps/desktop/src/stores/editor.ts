import { createStore } from "solid-js/store";

import type { DocumentHost } from "~/plugins/document_sessions";
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
  | {
      status: "skipped";
      reason:
        | "diff"
        | "not-ready"
        | "missing-checksum"
        | "disposed"
        | "dirty"
        | "saving"
        | "retained"
        | "unchanged";
    }
  | { status: "conflict"; expected: string; actual: string }
  | { status: "error"; message: string };

interface EditorDocumentSession {
  tabId: string;
  filePath: string;
  save(): Promise<EditorSaveResult>;
  reloadFromDisk(): Promise<EditorSaveResult>;
  getChecksum(): string | null;
  getHost?(): DocumentHost | null;
}

const [editorState, setEditorState] = createStore<EditorState>({
  tabId: null,
  filePath: null,
  checksum: null,
  isDirty: false,
  isLoading: false,
});

const documentListeners = new Set<(session: EditorDocumentSession | null) => void>();

function onEditorDocumentReady(
  listener: (session: EditorDocumentSession | null) => void,
): Disposer {
  documentListeners.add(listener);
  return () => {
    documentListeners.delete(listener);
  };
}

function notifyEditorDocumentReady(): void {
  for (const listener of documentListeners) listener(activeDocumentSession);
}

let activeDocumentSession: EditorDocumentSession | null = null;

function registerEditorDocumentSession(session: EditorDocumentSession): Disposer {
  activeDocumentSession = session;
  return () => {
    if (activeDocumentSession === session) {
      activeDocumentSession = null;
      notifyEditorDocumentReady();
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
  onEditorDocumentReady,
  notifyEditorDocumentReady,
  getEditorDocumentSession,
  registerEditorDocumentSession,
  resetEditorState,
  setEditorState,
};
export type { EditorDocumentSession, EditorSaveResult, EditorState };
