import { getSourceFilePathFromDiffPath } from "~/stores/diff_store";

interface TabLike {
  id: string;
  filePath: string | null;
  type: string;
}

interface ReconcileTabsResult<T extends TabLike> {
  tabs: T[];
  activeTabId: string | null;
  removedTabIds: string[];
}

function reconcileTabsWithExistingPaths<T extends TabLike>(
  tabs: T[],
  activeTabId: string | null,
  existingPaths: Set<string>,
): ReconcileTabsResult<T> {
  const resolvedFilePath = (tab: T): string | null => {
    if (tab.type === "diff") {
      return getSourceFilePathFromDiffPath(tab.filePath);
    }
    return tab.filePath;
  };

  // Compare case-insensitively so a tab whose path differs only in case from
  // the vault tree (e.g. after a case-only rename) isn't dropped on the next
  // refresh — on APFS/NTFS both resolve to the same on-disk file.
  const existingLower = new Set<string>();
  for (const path of existingPaths) {
    existingLower.add(path.toLowerCase());
  }

  const removedTabIds = tabs
    .filter((tab) => {
      if (tab.type !== "editor" && tab.type !== "diff") {
        return false;
      }

      const filePath = resolvedFilePath(tab);
      return filePath !== null && !existingLower.has(filePath.toLowerCase());
    })
    .map((tab) => tab.id);

  if (removedTabIds.length === 0) {
    return {
      tabs,
      activeTabId,
      removedTabIds,
    };
  }

  const removedSet = new Set(removedTabIds);
  const nextTabs = tabs.filter((tab) => !removedSet.has(tab.id));

  let nextActiveTabId = activeTabId;
  if (activeTabId && removedSet.has(activeTabId)) {
    nextActiveTabId = null;
    const activeIndex = tabs.findIndex((tab) => tab.id === activeTabId);

    for (let index = activeIndex + 1; index < tabs.length; index += 1) {
      if (!removedSet.has(tabs[index].id)) {
        nextActiveTabId = tabs[index].id;
        break;
      }
    }

    if (!nextActiveTabId) {
      for (let index = activeIndex - 1; index >= 0; index -= 1) {
        if (!removedSet.has(tabs[index].id)) {
          nextActiveTabId = tabs[index].id;
          break;
        }
      }
    }
  }

  return {
    tabs: nextTabs,
    activeTabId: nextActiveTabId,
    removedTabIds,
  };
}

export { reconcileTabsWithExistingPaths };
export type { ReconcileTabsResult, TabLike };
