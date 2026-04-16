import { getActiveEditorInstance } from "~/components/editor/system/editor_engine";
import { getSourceFilePathFromDiffPath } from "~/stores/diff_store";
import { filesState, getActiveTab } from "~/stores/files";

import type { ChatSnapshotSource, EditorContext } from "./types";

function fileContextPathForTab(
  tab: { type: string; filePath: string | null } | undefined,
): string | null {
  if (!tab?.filePath) return null;
  if (tab.type === "editor") return tab.filePath;
  if (tab.type === "diff") return getSourceFilePathFromDiffPath(tab.filePath);
  return null;
}

function createContextSnapshotSource(): ChatSnapshotSource {
  return {
    snapshot(): EditorContext {
      const editor = getActiveEditorInstance();
      const activeTab = getActiveTab();
      const activeFile = fileContextPathForTab(activeTab);
      const openTabs = [
        ...new Set(
          filesState.tabs
            .map((tab) => fileContextPathForTab(tab))
            .filter((path): path is string => typeof path === "string" && path.length > 0),
        ),
      ];
      const selectedText =
        editor?.view && !editor.view.state.selection.empty
          ? editor.view.state.doc.textBetween(
              editor.view.state.selection.from,
              editor.view.state.selection.to,
              "\n",
            )
          : null;

      return {
        activeFile,
        selectedText,
        openTabs,
        cursorLine: null,
      };
    },
  };
}

export { createContextSnapshotSource };
