import { describe, expect, it } from "vitest";
import { Schema } from "prosekit/pm/model";
import { EditorState, TextSelection } from "prosekit/pm/state";
import {
  getEditorDocumentSession,
  registerEditorDocumentSession,
  type EditorDocumentSession,
} from "~/stores/editor";
import { notifyDocumentChanged } from "./document_events";
import { onEvent } from "./events";

const schema = new Schema({
  nodes: { doc: { content: "paragraph+" }, paragraph: { content: "text*" }, text: {} },
});

function session(path: string): EditorDocumentSession {
  return {
    tabId: path,
    filePath: path,
    getChecksum: () => "sum",
    save: async () => ({ status: "skipped", reason: "not-ready" }),
    reloadFromDisk: async () => ({ status: "skipped", reason: "not-ready" }),
  };
}

describe("production document event bridge", () => {
  it("emits only a real PM document change, not a caret or equivalent-state update", () => {
    const observed: string[] = [];
    const dispose = onEvent("editor:documentChanged", ({ filePath }) => observed.push(filePath));
    try {
      const state = EditorState.create({
        schema,
        doc: schema.node("doc", null, [schema.node("paragraph", null, schema.text("Task"))]),
      });
      const selectionOnly = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 2)));
      notifyDocumentChanged("Notes.md", state.doc, selectionOnly.doc);
      notifyDocumentChanged("Notes.md", state.doc, schema.nodeFromJSON(state.doc.toJSON()));
      const edited = state.apply(state.tr.insertText("new ", 1));
      notifyDocumentChanged("Notes.md", state.doc, edited.doc);
      expect(observed).toEqual(["Notes.md"]);
    } finally {
      dispose();
    }
  });

  it("emits active-session changes from real registration and cleanup without clearing a newer session", () => {
    const observed: (string | null)[] = [];
    const dispose = onEvent("editor:activeChanged", ({ filePath }) => observed.push(filePath));
    const releaseFirst = registerEditorDocumentSession(session("First.md"));
    const releaseSecond = registerEditorDocumentSession(session("Second.md"));
    try {
      releaseFirst();
      releaseSecond();
      expect(observed).toEqual(["First.md", "Second.md", null]);
    } finally {
      releaseFirst();
      releaseSecond();
      dispose();
    }
  });

  it("keeps a mounted session addressable after its source note is renamed", () => {
    let path = "Before.md";
    const mounted = {
      ...session(path),
      get filePath() {
        return path;
      },
    };
    const release = registerEditorDocumentSession(mounted);
    try {
      expect(getEditorDocumentSession("Before.md")).toBe(mounted);
      path = "Folder/After.md";
      expect(getEditorDocumentSession("Before.md")).toBeNull();
      expect(getEditorDocumentSession("Folder/After.md")).toBe(mounted);
    } finally {
      release();
    }
  });
});
