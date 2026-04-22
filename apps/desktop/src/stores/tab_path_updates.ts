import { getPathName, isSameOrDescendantPath, remapMovedPath } from "~/lib/vault_path";
import { createDiffTabPath, getSourceFilePathFromDiffPath } from "~/stores/diff_store";

interface TabPathLike {
  id: string;
  type: string;
  filePath: string | null;
  fileName: string;
}

function renameTabsForMovedPathInList<T extends TabPathLike>(
  tabs: T[],
  from: string,
  to: string,
  isDir: boolean,
): T[] {
  let didChange = false;

  const nextTabs = tabs.map((tab) => {
    if (tab.type === "editor" && tab.filePath) {
      const nextFilePath = remapMovedPath(tab.filePath, from, to, isDir);
      if (nextFilePath === tab.filePath) {
        return tab;
      }

      didChange = true;
      return {
        ...tab,
        filePath: nextFilePath,
        fileName: getPathName(nextFilePath),
      };
    }

    if (tab.type === "diff" && tab.filePath) {
      const sourceFilePath = getSourceFilePathFromDiffPath(tab.filePath);
      if (!sourceFilePath) {
        return tab;
      }

      const nextSourceFilePath = remapMovedPath(sourceFilePath, from, to, isDir);
      if (nextSourceFilePath === sourceFilePath) {
        return tab;
      }

      didChange = true;
      return {
        ...tab,
        filePath: createDiffTabPath(nextSourceFilePath),
        fileName: `Diff: ${getPathName(nextSourceFilePath)}`,
      };
    }

    return tab;
  });

  return didChange ? nextTabs : tabs;
}

function getTabIdsForDeletedPath(
  tabs: Pick<TabPathLike, "id" | "type" | "filePath">[],
  path: string,
  isDir: boolean,
): string[] {
  return tabs
    .filter((tab) => {
      if (!tab.filePath) return false;

      if (tab.type === "editor") {
        return isSameOrDescendantPath(tab.filePath, path, isDir);
      }

      if (tab.type === "diff") {
        const sourceFilePath = getSourceFilePathFromDiffPath(tab.filePath);
        return sourceFilePath ? isSameOrDescendantPath(sourceFilePath, path, isDir) : false;
      }

      return false;
    })
    .map((tab) => tab.id);
}

export { getTabIdsForDeletedPath, renameTabsForMovedPathInList };
export type { TabPathLike };
