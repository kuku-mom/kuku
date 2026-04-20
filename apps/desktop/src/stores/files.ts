import { getCurrentWindow } from "@tauri-apps/api/window";
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

type TabType = "editor" | "diff" | "graph" | "search" | "settings";

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
      .filter((tab) => tab.type !== "diff")
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
      cachedContent: {},
      cachedChecksums: {},
      viewportState: {},
    };
  } catch {
    return emptyState;
  }
}

function saveTabsSync(): void {
  const persistedTabs = filesState.tabs.filter((tab) => tab.type !== "diff");
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
 * @deprecated Do not add new Settings navigation call sites with this helper.
 * Settings is moving to a typed `openSettings(target)` API so callers can
 * target a specific category / plugin section / anchor instead of only the
 * singleton `"settings"` tab.
 */
function openTab(fileName: string, filePath: string | null = null, type: TabType = "editor"): void {
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
      setFilesState("activeTabId", existing.id);
      saveTabsSync();
      return;
    }
  }

  // Focus existing singleton tab (graph, search, settings)
  if (type !== "editor" && type !== "diff") {
    const existing = filesState.tabs.find((t) => t.type === type);
    if (existing) {
      setFilesState("activeTabId", existing.id);
      saveTabsSync();
      return;
    }
  }

  const tab = createTab(fileName, filePath, type);
  setFilesState(
    produce((s) => {
      s.tabs.push(tab);
      s.activeTabId = tab.id;
    }),
  );
  saveTabsSync();
}

function openSettings(target?: SettingsTarget): void {
  const existingIndex = filesState.tabs.findIndex((tab) => tab.type === "settings");
  if (existingIndex !== -1) {
    setFilesState(
      produce((state) => {
        state.activeTabId = state.tabs[existingIndex].id;
        if (target) {
          state.tabs[existingIndex].state ??= {};
          state.tabs[existingIndex].state.settingsTarget = target;
        }
      }),
    );
    saveTabsSync();
    return;
  }

  const tab = createTab(
    "Settings",
    null,
    "settings",
    target ? { settingsTarget: target } : undefined,
  );
  setFilesState(
    produce((state) => {
      state.tabs.push(tab);
      state.activeTabId = tab.id;
    }),
  );
  saveTabsSync();
}

function setSettingsTarget(target: SettingsTarget | undefined): void {
  const settingsIndex = filesState.tabs.findIndex((tab) => tab.type === "settings");
  if (settingsIndex === -1) return;

  setFilesState(
    produce((state) => {
      const tab = state.tabs[settingsIndex];
      if (!target) {
        if (tab.state) {
          delete tab.state.settingsTarget;
          if (Object.keys(tab.state).length === 0) {
            delete tab.state;
          }
        }
        return;
      }

      tab.state ??= {};
      tab.state.settingsTarget = target;
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
  preserveSettingsTab?: boolean;
  settingsTarget?: SettingsTarget;
}): void {
  for (const tab of filesState.tabs) {
    purgeClosedTab(tab);
  }

  const tabs =
    options?.preserveSettingsTab === true
      ? [
          createTab(
            "Settings",
            null,
            "settings",
            options.settingsTarget ? { settingsTarget: options.settingsTarget } : undefined,
          ),
        ]
      : [];

  setFilesState({
    tabs,
    activeTabId: tabs[0]?.id ?? null,
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
  for (const tabId of tabIds) {
    closeTab(tabId);
  }
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

// ── Window close handler (intercepts ⌘W) ──

let closeUnlisten: (() => void) | undefined;

async function initCloseHandler(): Promise<void> {
  closeUnlisten = await getCurrentWindow().onCloseRequested((event) => {
    event.preventDefault();
    const tab = getActiveTab();
    if (tab) {
      closeTab(tab.id);
    }
  });
}

function destroyCloseHandler(): void {
  closeUnlisten?.();
  closeUnlisten = undefined;
}

// ── Exports ──

export {
  closeTabsForDeletedPath,
  closeTab,
  clearEditorTabs,
  destroyCloseHandler,
  getCachedChecksum,
  filesState,
  getCachedContent,
  getActiveTab,
  getActiveEditorFolder,
  getViewportState,
  initCloseHandler,
  markTabDirty,
  nextTab,
  openSettings,
  openTab,
  prevTab,
  reconcileEditorTabsWithVault,
  renameTabsForMovedPath,
  resetFilesState,
  saveCachedChecksum,
  saveCachedContent,
  saveViewportState,
  setSettingsTarget,
  setActiveTab,
};
export type { SettingsCategoryId, SettingsTarget, Tab, TabType };
export type { ViewportState };
