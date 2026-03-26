import { type UnlistenFn, listen } from "@tauri-apps/api/event";
import { createStore, produce } from "solid-js/store";

import { clearEditorTabs, reconcileEditorTabsWithVault } from "~/stores/files";
import { setTopLevelSetting } from "~/stores/settings";
import {
  getConfiguredVaultStatus,
  NO_CONFIGURED_VAULT_STATUS,
  type ConfiguredVaultStatus,
} from "~/stores/vault_status";
import { buildVaultTreeIndex, reconcileVaultUiState } from "~/stores/vault_tree";
import { createWatcherRefreshScheduler } from "~/stores/watcher_refresh";
import { emitEvent } from "~/plugins/events";
import {
  closeVault as closeVaultCommand,
  listVaultFiles,
  openVault as openVaultCommand,
  readVaultFile,
  readVaultFileWithChecksum,
  vaultExists,
  vaultMkdir,
  vaultRemove,
  vaultRename,
  writeVaultFile,
  writeVaultFileWithChecksum,
  type ChecksumWriteResult,
  type FileChangeEvent,
  type FileEntry,
  type FileReadResult,
} from "~/lib/vault_fs";

interface EditState {
  parentPath: string;
  isDir: boolean;
  name: string;
}

interface VaultState {
  rootPath: string | null;
  rootName: string | null;
  files: FileEntry[];
  expandedFolders: Set<string>;
  selectedPath: string | null;
  editState: EditState | null;
  isWatching: boolean;
  configuredVaultStatus: ConfiguredVaultStatus | null;
}

const [vaultState, setVaultState] = createStore<VaultState>({
  rootPath: null,
  rootName: null,
  files: [],
  expandedFolders: new Set<string>(),
  selectedPath: null,
  editState: null,
  isWatching: false,
  configuredVaultStatus: NO_CONFIGURED_VAULT_STATUS,
});

let watcherUnlisten: UnlistenFn | null = null;
const watcherRefreshScheduler = createWatcherRefreshScheduler(async () => {
  const root = vaultState.rootPath;
  if (!root) return;

  try {
    await loadFiles(root);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("Failed to refresh vault after watcher event", error);
  }
});

function rootNameFromPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.at(-1) ?? path;
}

function resetVaultUi(
  status: ConfiguredVaultStatus | null = vaultState.configuredVaultStatus,
): void {
  setVaultState(
    produce((s) => {
      s.rootPath = null;
      s.rootName = null;
      s.files = [];
      s.expandedFolders = new Set<string>();
      s.selectedPath = null;
      s.editState = null;
      s.isWatching = false;
      s.configuredVaultStatus = status;
    }),
  );
}

async function loadFiles(rootPath: string): Promise<void> {
  const files = await listVaultFiles("");
  const index = buildVaultTreeIndex(files);
  const nextUiState = reconcileVaultUiState(index, {
    expandedFolders: vaultState.expandedFolders,
    selectedPath: vaultState.selectedPath,
    editState: vaultState.editState,
  });

  setVaultState(
    produce((s) => {
      s.files = files;
      s.rootPath = rootPath;
      s.rootName = rootNameFromPath(rootPath);
      s.expandedFolders = nextUiState.expandedFolders;
      s.selectedPath = nextUiState.selectedPath;
      s.editState = nextUiState.editState;
    }),
  );
  reconcileEditorTabsWithVault(files);
}

async function startWatcher(): Promise<void> {
  if (watcherUnlisten) {
    watcherUnlisten();
    watcherUnlisten = null;
  }

  watcherUnlisten = await listen<FileChangeEvent>("vault:file-changed", () => {
    watcherRefreshScheduler.schedule();
  });

  setVaultState("isWatching", true);
}

async function stopWatcher(): Promise<void> {
  watcherRefreshScheduler.cancel();
  if (watcherUnlisten) {
    watcherUnlisten();
    watcherUnlisten = null;
  }
  setVaultState("isWatching", false);
}

async function openVault(path: string): Promise<void> {
  await stopWatcher();
  setVaultState("configuredVaultStatus", getConfiguredVaultStatus(path, null));

  try {
    await openVaultCommand(path);
    clearEditorTabs();
    setTopLevelSetting("lastOpenedVault", path);

    setVaultState(
      produce((s) => {
        s.rootPath = path;
        s.rootName = rootNameFromPath(path);
        s.expandedFolders = new Set<string>();
        s.selectedPath = null;
        s.editState = null;
        s.configuredVaultStatus = null;
      }),
    );

    await startWatcher();
    await loadFiles(path);
    emitEvent("vault:opened", { rootPath: path });
  } catch (error) {
    await stopWatcher();
    try {
      await closeVaultCommand();
    } catch {
      // Ignore cleanup failures and surface the original open error.
    }

    clearEditorTabs();
    resetVaultUi(getConfiguredVaultStatus(path, error));
    emitEvent("vault:closed", undefined);
    throw error;
  }
}

async function closeVault(): Promise<void> {
  await stopWatcher();
  await closeVaultCommand();
  clearEditorTabs();
  resetVaultUi();
  emitEvent("vault:closed", undefined);
}

async function clearConfiguredVault(): Promise<void> {
  setTopLevelSetting("lastOpenedVault", null);
  await closeVault();
  setVaultState("configuredVaultStatus", NO_CONFIGURED_VAULT_STATUS);
}

function syncConfiguredVaultSelection(path: string | null): void {
  setVaultState("configuredVaultStatus", getConfiguredVaultStatus(path, null));
}

function toggleFolder(path: string): void {
  setVaultState(
    produce((s) => {
      const next = new Set(s.expandedFolders);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      s.expandedFolders = next;
    }),
  );
}

function isFolderExpanded(path: string): boolean {
  return vaultState.expandedFolders.has(path);
}

function setSelectedPath(path: string | null): void {
  setVaultState("selectedPath", path);
}

function findInTree(entries: FileEntry[], targetPath: string): FileEntry | null {
  for (const entry of entries) {
    if (entry.path === targetPath) return entry;
    if (entry.children) {
      const found = findInTree(entry.children, targetPath);
      if (found) return found;
    }
  }
  return null;
}

function getCreationFolder(): string {
  const root = vaultState.rootPath;
  if (!root) return "";
  if (!vaultState.selectedPath) return "";

  const entry = findInTree(vaultState.files, vaultState.selectedPath);
  if (!entry) return "";

  if (entry.is_directory) return entry.path;
  const idx = entry.path.lastIndexOf("/");
  return idx !== -1 ? entry.path.slice(0, idx) : "";
}

function expandFolder(path: string): void {
  setVaultState(
    produce((s) => {
      const next = new Set(s.expandedFolders);
      next.add(path);
      s.expandedFolders = next;
    }),
  );
}

function revealPath(filePath: string): void {
  if (!vaultState.rootPath) return;

  const segments = filePath.split("/").filter(Boolean);
  if (segments.length <= 1) return;

  setVaultState(
    produce((s) => {
      const next = new Set(s.expandedFolders);
      let current = "";
      for (let i = 0; i < segments.length - 1; i++) {
        current = current ? `${current}/${segments[i]}` : segments[i];
        next.add(current);
      }
      s.expandedFolders = next;
    }),
  );
}

function existsInTree(entries: FileEntry[], targetPath: string): boolean {
  for (const entry of entries) {
    if (entry.path === targetPath) return true;
    if (entry.children && existsInTree(entry.children, targetPath)) return true;
  }
  return false;
}

function startCreateFile(): void {
  const root = vaultState.rootPath;
  if (!root) return;

  const base = getCreationFolder();
  if (base) expandFolder(base);
  setVaultState("editState", { parentPath: base, isDir: false, name: "" });
}

function startCreateFolder(): void {
  const root = vaultState.rootPath;
  if (!root) return;

  const base = getCreationFolder();
  if (base) expandFolder(base);
  setVaultState("editState", { parentPath: base, isDir: true, name: "" });
}

function updateEditName(name: string): void {
  if (!vaultState.editState) return;
  setVaultState("editState", "name", name);
}

async function confirmEdit(): Promise<void> {
  const edit = vaultState.editState;
  const root = vaultState.rootPath;
  if (!edit || !root) return;

  const name = edit.name.trim();
  if (!name) {
    cancelEdit();
    return;
  }

  const targetPath = edit.parentPath ? `${edit.parentPath}/${name}` : name;

  if (existsInTree(vaultState.files, targetPath)) {
    cancelEdit();
    return;
  }

  setVaultState("editState", null);

  await (edit.isDir ? vaultMkdir(targetPath) : writeVaultFile(targetPath, ""));

  await loadFiles(root);
}

function cancelEdit(): void {
  setVaultState("editState", null);
}

async function readFile(path: string): Promise<string> {
  return readVaultFile(path);
}

async function readFileWithChecksum(path: string): Promise<FileReadResult> {
  return readVaultFileWithChecksum(path);
}

async function writeFile(path: string, content: string): Promise<void> {
  await writeVaultFile(path, content);
}

async function writeFileWithChecksum(
  path: string,
  content: string,
  checksum: string,
): Promise<ChecksumWriteResult> {
  return writeVaultFileWithChecksum(path, content, checksum);
}

async function exists(path: string): Promise<boolean> {
  return vaultExists(path);
}

async function remove(path: string): Promise<void> {
  await vaultRemove(path);
}

async function rename(from: string, to: string): Promise<void> {
  await vaultRename(from, to);
}

export {
  cancelEdit,
  clearConfiguredVault,
  closeVault,
  confirmEdit,
  exists,
  expandFolder,
  findInTree,
  getCreationFolder,
  isFolderExpanded,
  loadFiles,
  existsInTree,
  openVault,
  readFile,
  readFileWithChecksum,
  remove,
  rename,
  revealPath,
  setSelectedPath,
  startCreateFile,
  startCreateFolder,
  startWatcher,
  stopWatcher,
  syncConfiguredVaultSelection,
  toggleFolder,
  updateEditName,
  vaultState,
  writeFile,
  writeFileWithChecksum,
};
export type { ConfiguredVaultStatus, EditState, VaultState };
