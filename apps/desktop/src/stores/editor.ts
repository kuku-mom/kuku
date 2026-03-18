import { createStore } from "solid-js/store";

interface EditorState {
  tabId: string | null;
  filePath: string | null;
  checksum: string | null;
  isDirty: boolean;
  isLoading: boolean;
}

const [editorState, setEditorState] = createStore<EditorState>({
  tabId: null,
  filePath: null,
  checksum: null,
  isDirty: false,
  isLoading: false,
});

export { editorState, setEditorState };
export type { EditorState };
