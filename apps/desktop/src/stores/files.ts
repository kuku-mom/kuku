import { createStore, produce } from "solid-js/store";

import type { PMNodeJSON } from "~/lib/markdown";
import type { FileEntry } from "~/lib/vault_fs";
import { pathEqualsIgnoreCase } from "~/lib/vault_path";
import { getTabIdsForDeletedPath, renameTabsForMovedPathInList } from "~/stores/tab_path_updates";
import { reconcileTabsWithExistingPaths } from "~/stores/file_tabs_reconcile";
import {
  getSourceFilePathFromDiffPath,
  isDiffTabPath,
  removeDiffEntry,
  renameDiffEntriesForMovedPath,
} from "~/stores/diff_store";
import { buildVaultTreeIndex } from "~/stores/vault_tree";

// ── Types ──

type TabType = "editor" | "diff" | "graph" | "search" | "settings" | "placeholder";

type SettingsCategoryId =
  | "general"
  | "appearance"
  | "editor"
  | "files"
  | "keybindings"
  | "plugins"
  | "about"
  | "debug";

type SettingsTarget =
  | {
      kind: "category";
      categoryId: SettingsCategoryId;
      anchor?: string;
    }
  | {
      kind: "plugin";
      fillId: string;
      anchor?: string;
    };

interface TabState {
  settingsTarget?: SettingsTarget;
}

interface Tab {
  id: string;
  fileName: string;
  filePath: string | null;
  type: TabType;
  isDirty: boolean;
  state?: TabState;
}

interface FilesState {
  tabs: Tab[];
  activeTabId: string | null;
  settingsDialogOpen: boolean;
  settingsTarget?: SettingsTarget;
  cachedContent: Record<string, PMNodeJSON>;
  cachedChecksums: Record<string, string>;
  viewportState: Record<string, ViewportState>;
}

interface ViewportState {
  scrollTop: number;
  selectionAnchor: number;
  selectionHead: number;
  wasFocused: boolean;
}

// ── Helpers ──

const STORE_KEY = "tabs-state";

function createTab(
  fileName: string,
  filePath: string | null = null,
  type: TabType = "editor",
  state?: TabState,
): Tab {
  return {
    id: crypto.randomUUID(),
    fileName,
    filePath,
    type,
    isDirty: false,
    state,
  };
}

function loadTabsSync(): FilesState {
  const emptyState: FilesState = {
    tabs: [],
    activeTabId: null,
    settingsDialogOpen: false,
    settingsTarget: undefined,
    cachedContent: {},
    cachedChecksums: {},
    viewportState: {},
  };

  const raw = localStorage.getItem(STORE_KEY);
  if (!raw) return emptyState;
  try {
    const data = JSON.parse(raw) as {
      tabs?: {
        fileName: string;
        filePath: string;
        type?: TabType;
        state?: TabState;
      }[];
      activeFilePath?: string | null;
    };
    if (!data?.tabs?.length) {
      return emptyState;
    }

    const restored = data.tabs
      .filter(
        (tab) => tab.type !== "diff" && tab.type !== "settings" && tab.type !== "placeholder",
      )
      .map((t) => createTab(t.fileName, t.filePath || null, t.type ?? "editor", t.state));
    const activeFilePath = data.activeFilePath;
    const active = activeFilePath
      ? restored.find(
          (t) => t.filePath !== null && pathEqualsIgnoreCase(t.filePath, activeFilePath),
        )
      : restored[0];

    return {
      tabs: restored,
      activeTabId: active?.id ?? null,
      settingsDialogOpen: false,
      settingsTarget: undefined,
      cachedContent: {},
      cachedChecksums: {},
      viewportState: {},
    };
  } catch {
    return emptyState;
  }
}

function saveTabsSync(): void {
  const persistedTabs = filesState.tabs.filter(
    (tab) => tab.type !== "diff" && tab.type !== "settings" && tab.type !== "placeholder",
  );
  const active = getActiveTab();
  const data = {
    tabs: persistedTabs.map((t) => ({
      fileName: t.fileName,
      filePath: t.filePath ?? "",
      type: t.type,
      state: t.state,
    })),
    activeFilePath: active?.type === "diff" ? null : (active?.filePath ?? null),
  };
  localStorage.setItem(STORE_KEY, JSON.stringify(data));
}

// ── Store ──

const [filesState, setFilesState] = createStore<FilesState>(loadTabsSync());

// ── Getters ──

function getActiveTab(): Tab | undefined {
  return filesState.tabs.find((t) => t.id === filesState.activeTabId);
}

function getActiveEditorFolder(): string {
  const activeTab = getActiveTab();
  if (!activeTab?.filePath) return "";

  let sourcePath: string | null = null;
  if (activeTab.type === "diff") {
    sourcePath = getSourceFilePathFromDiffPath(activeTab.filePath);
  } else if (activeTab.type === "editor") {
    sourcePath = activeTab.filePath;
  }

  if (!sourcePath) return "";

  const idx = sourcePath.lastIndexOf("/");
  return idx !== -1 ? sourcePath.slice(0, idx) : "";
}

// ── Actions ──

/**
 * Opens or focuses a tab.
 *
 * @remarks Prefer {@link openSettings} for Settings navigation — it accepts a
 * typed `target` so callers can deep-link to a specific category, plugin
 * section, or anchor instead of only opening the singleton `"settings"` tab.
 * @see {@link openSettings}
 */
function openTab(fileName: string, filePath: string | null = null, type: TabType = "editor"): void {
  if (type === "settings") {
    openSettings();
    return;
  }
  if (type === "placeholder") {
    openNewTabPlaceholder();
    return;
  }

  // Focus existing tab if same filePath + tab type. Match case-insensitively
  // so a file opened as `Foo.md` and then accessed as `foo.md` from the
  // vault tree doesn't create a second tab pointing at the same on-disk
  // entry (APFS/NTFS both resolve them to the same file, and two tabs
  // would fork dirty state and conflict on save).
  if (filePath) {
    const existing = filesState.tabs.find(
      (t) => t.type === type && t.filePath !== null && pathEqualsIgnoreCase(t.filePath, filePath),
    );
    if (existing) {
      setFilesState(
        produce((state) => {
          state.tabs = state.tabs.filter((tab) => tab.type !== "placeholder");
          state.activeTabId = existing.id;
        }),
      );
      saveTabsSync();
      return;
    }
  }

  // Focus existing singleton tab (graph, search, settings)
  if (type !== "editor" && type !== "diff") {
    const existing = filesState.tabs.find((t) => t.type === type);
    if (existing) {
      setFilesState(
        produce((state) => {
          state.tabs = state.tabs.filter((tab) => tab.type !== "placeholder");
          state.activeTabId = existing.id;
        }),
      );
      saveTabsSync();
      return;
    }
  }

  const tab = createTab(fileName, filePath, type);
  setFilesState(
    produce((s) => {
      if (type !== "placeholder") {
        s.tabs = s.tabs.filter((existingTab) => existingTab.type !== "placeholder");
      }
      s.tabs.push(tab);
      s.activeTabId = tab.id;
    }),
  );
  saveTabsSync();
}

function openNewTabPlaceholder(): void {
  const existing = filesState.tabs.find((tab) => tab.type === "placeholder");
  if (existing) {
    setFilesState("activeTabId", existing.id);
    saveTabsSync();
    return;
  }

  const tab = createTab("New Tab", null, "placeholder");
  setFilesState(
    produce((state) => {
      state.tabs.push(tab);
      state.activeTabId = tab.id;
    }),
  );
  saveTabsSync();
}

function openSettings(target?: SettingsTarget): void {
  setFilesState(
    produce((state) => {
      const tabs = state.tabs.filter((tab) => tab.type !== "settings");
      if (tabs.length !== state.tabs.length) {
        state.tabs = tabs;
        if (state.activeTabId && !tabs.some((tab) => tab.id === state.activeTabId)) {
          state.activeTabId = tabs[0]?.id ?? null;
        }
      }
      state.settingsDialogOpen = true;
      if (target) {
        state.settingsTarget = target;
      }
    }),
  );
  saveTabsSync();
}

function closeSettings(): void {
  setFilesState(
    produce((state) => {
      state.settingsDialogOpen = false;
      delete state.settingsTarget;
    }),
  );
  saveTabsSync();
}

function setSettingsTarget(target: SettingsTarget | undefined): void {
  setFilesState(
    produce((state) => {
      if (!target) {
        delete state.settingsTarget;
        return;
      }

      state.settingsTarget = target;
    }),
  );
  saveTabsSync();
}

function closeTab(tabId: string): void {
  const idx = filesState.tabs.findIndex((t) => t.id === tabId);
  if (idx === -1) return;
  const closedTab = filesState.tabs[idx];

  setFilesState(
    produce((s) => {
      if (s.activeTabId === tabId) {
        if (s.tabs.length > 1) {
          const nextIdx = idx < s.tabs.length - 1 ? idx + 1 : idx - 1;
          s.activeTabId = s.tabs[nextIdx].id;
        } else {
          s.activeTabId = null;
        }
      }
      s.tabs.splice(idx, 1);
    }),
  );
  purgeClosedTab(closedTab);
  saveTabsSync();
}

function reorderTabs(fromIndex: number, toIndex: number): void {
  const len = filesState.tabs.length;
  if (fromIndex < 0 || fromIndex >= len) return;
  if (toIndex < 0) toIndex = 0;
  if (toIndex > len - 1) toIndex = len - 1;
  if (fromIndex === toIndex) return;

  setFilesState(
    produce((s) => {
      const [tab] = s.tabs.splice(fromIndex, 1);
      s.tabs.splice(toIndex, 0, tab);
    }),
  );
  saveTabsSync();
}

function clearEditorTabs(): void {
  const editorTabs = filesState.tabs.filter((t) => t.type === "editor" || t.type === "diff");
  for (const tab of editorTabs) {
    purgeClosedTab(tab);
  }

  const tabs = filesState.tabs.filter((t) => t.type !== "editor" && t.type !== "diff");
  const active = tabs.find((t) => t.id === filesState.activeTabId) ?? tabs[0] ?? null;
  setFilesState(
    produce((s) => {
      s.tabs = tabs;
      s.activeTabId = active?.id ?? null;
    }),
  );
  saveTabsSync();
}

function resetFilesState(options?: {
  preserveSettingsDialog?: boolean;
  settingsTarget?: SettingsTarget;
}): void {
  for (const tab of filesState.tabs) {
    purgeClosedTab(tab);
  }

  setFilesState({
    tabs: [],
    activeTabId: null,
    settingsDialogOpen: options?.preserveSettingsDialog === true,
    settingsTarget: options?.settingsTarget,
    cachedContent: {},
    cachedChecksums: {},
    viewportState: {},
  });
  saveTabsSync();
}

function renameTabsForMovedPath(from: string, to: string, isDir: boolean): void {
  const nextTabs = renameTabsForMovedPathInList(filesState.tabs, from, to, isDir);
  if (nextTabs === filesState.tabs) return;

  setFilesState(
    produce((s) => {
      s.tabs = nextTabs;
    }),
  );
  renameDiffEntriesForMovedPath(from, to, isDir);
  saveTabsSync();
}

function closeTabsForDeletedPath(path: string, isDir: boolean): void {
  const tabIds = getTabIdsForDeletedPath(filesState.tabs, path, isDir);
  if (tabIds.length === 0) return;

  // Bulk removal: one `produce` + one `saveTabsSync`. The naive `tabIds.map(closeTab)`
  // loop triggers N reactive flushes and N localStorage writes for an N-tab
  // deletion (e.g. dropping a folder that holds many open files).
  const removedSet = new Set(tabIds);
  const currentTabs = filesState.tabs;
  const closedTabs = currentTabs.filter((tab) => removedSet.has(tab.id));
  const nextTabs = currentTabs.filter((tab) => !removedSet.has(tab.id));

  // Pick a surviving tab to activate if the current active is being closed.
  // Prefer the next tab after the active, fall back to the one before, then null.
  let nextActiveId = filesState.activeTabId;
  if (nextActiveId && removedSet.has(nextActiveId)) {
    const activeIndex = currentTabs.findIndex((tab) => tab.id === nextActiveId);
    nextActiveId = null;
    for (let i = activeIndex + 1; i < currentTabs.length; i += 1) {
      if (!removedSet.has(currentTabs[i].id)) {
        nextActiveId = currentTabs[i].id;
        break;
      }
    }
    if (!nextActiveId) {
      for (let i = activeIndex - 1; i >= 0; i -= 1) {
        if (!removedSet.has(currentTabs[i].id)) {
          nextActiveId = currentTabs[i].id;
          break;
        }
      }
    }
  }

  setFilesState(
    produce((s) => {
      s.tabs = nextTabs;
      s.activeTabId = nextActiveId;
      for (const id of removedSet) {
        delete s.cachedContent[id];
        delete s.cachedChecksums[id];
        delete s.viewportState[id];
      }
    }),
  );

  for (const tab of closedTabs) {
    if (tab.type === "diff" && tab.filePath && isDiffTabPath(tab.filePath)) {
      removeDiffEntry(tab.filePath);
    }
  }
  saveTabsSync();
}

function setActiveTab(tabId: string): void {
  setFilesState("activeTabId", tabId);
  saveTabsSync();
}

function markTabDirty(tabId: string, isDirty: boolean): void {
  const idx = filesState.tabs.findIndex((t) => t.id === tabId);
  if (idx === -1) return;
  setFilesState("tabs", idx, "isDirty", isDirty);
}

function getCachedContent(tabId: string): PMNodeJSON | null {
  return filesState.cachedContent[tabId] ?? null;
}

function saveCachedContent(tabId: string, content: PMNodeJSON): void {
  setFilesState("cachedContent", tabId, content);
}

function getCachedChecksum(tabId: string): string | null {
  return filesState.cachedChecksums[tabId] ?? null;
}

function saveCachedChecksum(tabId: string, checksum: string): void {
  setFilesState("cachedChecksums", tabId, checksum);
}

function getViewportState(tabId: string): ViewportState {
  return (
    filesState.viewportState[tabId] ?? {
      scrollTop: 0,
      selectionAnchor: 0,
      selectionHead: 0,
      wasFocused: false,
    }
  );
}

function saveViewportState(tabId: string, viewportState: ViewportState): void {
  setFilesState("viewportState", tabId, viewportState);
}

function purgeEditorRuntimeState(tabId: string): void {
  setFilesState(
    produce((s) => {
      delete s.cachedContent[tabId];
      delete s.cachedChecksums[tabId];
      delete s.viewportState[tabId];
    }),
  );
}

function purgeClosedTab(tab: Tab): void {
  purgeEditorRuntimeState(tab.id);
  if (tab.type === "diff" && tab.filePath && isDiffTabPath(tab.filePath)) {
    removeDiffEntry(tab.filePath);
  }
}

function reconcileEditorTabsWithVault(entries: FileEntry[]): void {
  const existingPaths = buildVaultTreeIndex(entries).allPaths;
  const next = reconcileTabsWithExistingPaths(
    filesState.tabs,
    filesState.activeTabId,
    existingPaths,
  );

  if (next.removedTabIds.length === 0) return;
  const removedTabs = filesState.tabs.filter((tab) => next.removedTabIds.includes(tab.id));

  setFilesState(
    produce((s) => {
      s.tabs = next.tabs;
      s.activeTabId = next.activeTabId;
      for (const tabId of next.removedTabIds) {
        delete s.cachedContent[tabId];
        delete s.cachedChecksums[tabId];
        delete s.viewportState[tabId];
      }
    }),
  );
  for (const tab of removedTabs) {
    if (tab.type === "diff" && tab.filePath && isDiffTabPath(tab.filePath)) {
      removeDiffEntry(tab.filePath);
    }
  }
  saveTabsSync();
}

function nextTab(): void {
  const { tabs, activeTabId } = filesState;
  if (!activeTabId || tabs.length <= 1) return;
  const idx = tabs.findIndex((t) => t.id === activeTabId);
  if (idx === -1) return;
  setFilesState("activeTabId", tabs[(idx + 1) % tabs.length].id);
}

function prevTab(): void {
  const { tabs, activeTabId } = filesState;
  if (!activeTabId || tabs.length <= 1) return;
  const idx = tabs.findIndex((t) => t.id === activeTabId);
  if (idx === -1) return;
  setFilesState("activeTabId", tabs[(idx - 1 + tabs.length) % tabs.length].id);
}

// ── New-file focus (one-shot) ──
//
// `createAndOpenNewFile` sets the active editor tab; the markdown surface mounts
// async, so we defer `editor.view.focus()` until after the first document load.

let pendingEditorFocusTabId: string | null = null;

function requestEditorFocusForTab(tabId: string): void {
  pendingEditorFocusTabId = tabId;
}

function consumeEditorFocusIfPendingForTab(tabId: string): boolean {
  if (pendingEditorFocusTabId !== tabId) {
    return false;
  }
  pendingEditorFocusTabId = null;
  return true;
}

// ── Exports ──

export {
  closeSettings,
  closeTabsForDeletedPath,
  closeTab,
  clearEditorTabs,
  consumeEditorFocusIfPendingForTab,
  getCachedChecksum,
  filesState,
  getCachedContent,
  getActiveTab,
  getActiveEditorFolder,
  getViewportState,
  markTabDirty,
  nextTab,
  openSettings,
  openNewTabPlaceholder,
  openTab,
  prevTab,
  reconcileEditorTabsWithVault,
  renameTabsForMovedPath,
  reorderTabs,
  requestEditorFocusForTab,
  resetFilesState,
  saveCachedChecksum,
  saveCachedContent,
  saveViewportState,
  setSettingsTarget,
  setActiveTab,
};
export type { SettingsCategoryId, SettingsTarget, Tab, TabType };
export type { ViewportState };
