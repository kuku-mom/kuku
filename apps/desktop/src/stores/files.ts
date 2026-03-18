import { getCurrentWindow } from "@tauri-apps/api/window";
import { createStore, produce } from "solid-js/store";

import type { PMNodeJSON } from "~/lib/markdown";
import { writeVaultFile } from "~/lib/vault_fs";
import { existsInTree, loadFiles, vaultState } from "~/stores/vault";

// ── Types ──

type TabType = "editor" | "graph" | "search" | "settings";

interface Tab {
  id: string;
  fileName: string;
  filePath: string | null;
  type: TabType;
  isDirty: boolean;
}

interface FilesState {
  tabs: Tab[];
  activeTabId: string | null;
  cachedContent: Record<string, PMNodeJSON>;
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
): Tab {
  return {
    id: crypto.randomUUID(),
    fileName,
    filePath,
    type,
    isDirty: false,
  };
}

function loadTabsSync(): FilesState {
  const raw = localStorage.getItem(STORE_KEY);
  if (!raw) return { tabs: [], activeTabId: null, cachedContent: {}, viewportState: {} };
  try {
    const data = JSON.parse(raw) as {
      tabs?: { fileName: string; filePath: string; type?: TabType }[];
      activeFilePath?: string | null;
    };
    if (!data?.tabs?.length) {
      return { tabs: [], activeTabId: null, cachedContent: {}, viewportState: {} };
    }

    const restored = data.tabs.map((t) =>
      createTab(t.fileName, t.filePath || null, t.type ?? "editor"),
    );
    const active = data.activeFilePath
      ? restored.find((t) => t.filePath === data.activeFilePath)
      : restored[0];

    return {
      tabs: restored,
      activeTabId: active?.id ?? null,
      cachedContent: {},
      viewportState: {},
    };
  } catch {
    return { tabs: [], activeTabId: null, cachedContent: {}, viewportState: {} };
  }
}

function saveTabsSync(): void {
  const active = getActiveTab();
  const data = {
    tabs: filesState.tabs.map((t) => ({
      fileName: t.fileName,
      filePath: t.filePath ?? "",
      type: t.type,
    })),
    activeFilePath: active?.filePath ?? null,
  };
  localStorage.setItem(STORE_KEY, JSON.stringify(data));
}

// ── Store ──

const [filesState, setFilesState] = createStore<FilesState>(loadTabsSync());

// ── Getters ──

function getActiveTab(): Tab | undefined {
  return filesState.tabs.find((t) => t.id === filesState.activeTabId);
}

// ── Actions ──

function openTab(fileName: string, filePath: string | null = null, type: TabType = "editor"): void {
  // Focus existing tab if same filePath
  if (filePath) {
    const existing = filesState.tabs.find((t) => t.filePath === filePath);
    if (existing) {
      setFilesState("activeTabId", existing.id);
      saveTabsSync();
      return;
    }
  }

  // Focus existing singleton tab (graph, search, settings)
  if (type !== "editor") {
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

function closeTab(tabId: string): void {
  const idx = filesState.tabs.findIndex((t) => t.id === tabId);
  if (idx === -1) return;

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
  purgeEditorRuntimeState(tabId);
  saveTabsSync();
}

function clearEditorTabs(): void {
  const editorTabIds = filesState.tabs.filter((t) => t.type === "editor").map((t) => t.id);
  for (const tabId of editorTabIds) {
    purgeEditorRuntimeState(tabId);
  }

  const tabs = filesState.tabs.filter((t) => t.type !== "editor");
  const active = tabs.find((t) => t.id === filesState.activeTabId) ?? tabs[0] ?? null;
  setFilesState(
    produce((s) => {
      s.tabs = tabs;
      s.activeTabId = active?.id ?? null;
    }),
  );
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
      delete s.viewportState[tabId];
    }),
  );
}

async function createAndOpenNewFile(): Promise<void> {
  const root = vaultState.rootPath;
  if (!root) {
    openTab("Untitled");
    return;
  }

  let name = "Untitled";
  let fileName = `${name}.md`;
  let filePath = fileName;
  let counter = 1;

  while (
    existsInTree(vaultState.files, filePath) ||
    filesState.tabs.some((t) => t.filePath === filePath)
  ) {
    name = `Untitled ${counter}`;
    fileName = `${name}.md`;
    filePath = fileName;
    counter++;
  }

  await writeVaultFile(filePath, "");
  await loadFiles(root);
  openTab(fileName, filePath);
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
  closeTab,
  clearEditorTabs,
  createAndOpenNewFile,
  destroyCloseHandler,
  filesState,
  getCachedContent,
  getActiveTab,
  getViewportState,
  initCloseHandler,
  markTabDirty,
  nextTab,
  openTab,
  prevTab,
  saveCachedContent,
  saveViewportState,
  setActiveTab,
};
export type { Tab, TabType };
export type { ViewportState };
