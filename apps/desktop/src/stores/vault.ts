import { type UnlistenFn, listen } from "@tauri-apps/api/event";
import { batch } from "solid-js";
import { createStore, produce } from "solid-js/store";

import {
  clearEditorTabs,
  closeTabsForDeletedPath,
  filesState,
  getActiveEditorFolder,
  getActiveTab,
  openTab,
  reconcileEditorTabsWithVault,
  renameTabsForMovedPath,
  requestEditorFocusForTab,
} from "~/stores/files";
import { setTopLevelSetting, settingsState } from "~/stores/settings";
import {
  getConfiguredVaultStatus,
  NO_CONFIGURED_VAULT_STATUS,
  type ConfiguredVaultStatus,
} from "~/stores/vault_status";
import { buildVaultTreeIndex, reconcileVaultUiState } from "~/stores/vault_tree";
import { createWatcherRefreshScheduler } from "~/stores/watcher_refresh";
import { emitEvent } from "~/plugins/events";
import {
  buildNameFromEditable,
  getParentPath,
  joinVaultPath,
  isSameOrDescendantPath,
  remapMovedPath,
  remapPathSet,
  splitNameForEditing,
} from "~/lib/vault_path";
import { sortVaultEntriesNaturally } from "~/lib/vault_sort";
import {
  chooseVaultDirectory,
  closeVault as closeVaultCommand,
  listVaultFiles,
  openVault as openVaultCommand,
  readVaultFile,
  readVaultFileWithChecksum,
  vaultDelete,
  vaultEmptyTrash,
  vaultExists,
  vaultGetTrashPath,
  vaultMkdir,
  vaultRename,
  writeVaultFile,
  writeVaultFileWithChecksum,
  type ChecksumWriteResult,
  type DeleteMode,
  type FileChangeEvent,
  type FileEntry,
  type FileReadResult,
} from "~/lib/vault_fs";

type RenameSurface = "browser" | "tab";

interface BaseEditState {
  targetPath: string;
  parentPath: string;
  isDir: boolean;
  name: string;
  preservedExtension: string | null;
}

interface CreateEditState extends BaseEditState {
  kind: "create";
}

interface RenameEditState extends BaseEditState {
  kind: "rename";
  surface: RenameSurface;
}

type EditState = CreateEditState | RenameEditState;

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
  const files = sortVaultEntriesNaturally(await listVaultFiles(""));
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

async function selectVault(): Promise<boolean> {
  const selected = await chooseVaultDirectory();
  if (!selected) return false;
  await openVault(selected);
  return true;
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

async function createAndOpenNewFile(): Promise<void> {
  const root = vaultState.rootPath;
  if (!root) {
    openTab("Untitled");
    const tab = getActiveTab();
    if (tab?.filePath) requestEditorFocusForTab(tab.id);
    return;
  }

  const basePath = settingsState.files.newFileLocation === "current" ? getActiveEditorFolder() : "";

  let name = "Untitled";
  let fileName = `${name}.md`;
  let filePath = basePath ? `${basePath}/${fileName}` : fileName;
  let counter = 1;

  while (
    existsInTree(vaultState.files, filePath) ||
    filesState.tabs.some((tab) => tab.filePath?.toLowerCase() === filePath.toLowerCase())
  ) {
    name = `Untitled ${counter}`;
    fileName = `${name}.md`;
    filePath = basePath ? `${basePath}/${fileName}` : fileName;
    counter++;
  }

  await writeVaultFile(filePath, "");
  await loadFiles(root);
  openTab(fileName, filePath);
  const tab = getActiveTab();
  if (tab) requestEditorFocusForTab(tab.id);
}

function setSelectedPath(path: string | null): void {
  setVaultState("selectedPath", path);
}

function findInTree(entries: FileEntry[], targetPath: string): FileEntry | null {
  const target = targetPath.toLowerCase();
  const visit = (nodes: FileEntry[]): FileEntry | null => {
    for (const entry of nodes) {
      if (entry.path.toLowerCase() === target) return entry;
      if (entry.children) {
        const found = visit(entry.children);
        if (found) return found;
      }
    }
    return null;
  };
  return visit(entries);
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

// Vault paths are compared case-insensitively so collision checks on
// case-insensitive filesystems (macOS APFS default, Windows NTFS default)
// match OS behaviour. Without this, creating `Untitled.md` next to an
// existing `untitled.md` silently overwrites the original file's contents.
function existsInTree(entries: FileEntry[], targetPath: string): boolean {
  const target = targetPath.toLowerCase();
  const visit = (nodes: FileEntry[]): boolean => {
    for (const entry of nodes) {
      if (entry.path.toLowerCase() === target) return true;
      if (entry.children && visit(entry.children)) return true;
    }
    return false;
  };
  return visit(entries);
}

function remapEditStateForMovedPath(
  editState: EditState,
  from: string,
  to: string,
  isDir: boolean,
): EditState {
  return {
    ...editState,
    targetPath: remapMovedPath(editState.targetPath, from, to, isDir),
    parentPath: remapMovedPath(editState.parentPath, from, to, isDir),
  };
}

function applyMovedPathToVaultUiState(from: string, to: string, isDir: boolean): void {
  setVaultState(
    produce((s) => {
      s.selectedPath = s.selectedPath ? remapMovedPath(s.selectedPath, from, to, isDir) : null;
      s.expandedFolders = remapPathSet(s.expandedFolders, from, to, isDir);
      s.editState = s.editState ? remapEditStateForMovedPath(s.editState, from, to, isDir) : null;
    }),
  );
}

function startCreateFile(): void {
  const root = vaultState.rootPath;
  if (!root) return;

  const base = getCreationFolder();
  if (base) expandFolder(base);
  setVaultState("editState", {
    kind: "create",
    targetPath: base,
    parentPath: base,
    isDir: false,
    name: "",
    preservedExtension: null,
  });
}

function startCreateFolder(): void {
  const root = vaultState.rootPath;
  if (!root) return;

  const base = getCreationFolder();
  if (base) expandFolder(base);
  setVaultState("editState", {
    kind: "create",
    targetPath: base,
    parentPath: base,
    isDir: true,
    name: "",
    preservedExtension: null,
  });
}

function startRename(path: string, surface: RenameSurface = "browser"): void {
  if (!vaultState.rootPath) return;

  const entry = findInTree(vaultState.files, path);
  if (!entry) return;

  const { editableName, preservedExtension } = splitNameForEditing(entry.name, entry.is_directory);

  batch(() => {
    setSelectedPath(entry.path);
    setVaultState("editState", {
      kind: "rename",
      surface,
      targetPath: entry.path,
      parentPath: getParentPath(entry.path),
      isDir: entry.is_directory,
      name: editableName,
      preservedExtension,
    });
  });
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

  if (edit.kind === "rename" && (name.includes("/") || name.includes("\\"))) {
    cancelEdit();
    return;
  }

  const nextName = buildNameFromEditable(name, edit.preservedExtension);
  const destinationPath = joinVaultPath(edit.parentPath, nextName);

  if (edit.kind === "rename") {
    if (destinationPath === edit.targetPath) {
      cancelEdit();
      return;
    }
  } else if (existsInTree(vaultState.files, destinationPath)) {
    cancelEdit();
    return;
  }

  // Case-only rename (e.g. `Foo.md` → `foo.md`) looks like a collision to the
  // case-insensitive `existsInTree`, but the "conflict" is the source itself —
  // on case-insensitive filesystems the OS resolves them to the same entry, so
  // the rename is effectively an in-place case change and must be allowed.
  if (
    edit.kind === "rename" &&
    destinationPath.toLowerCase() !== edit.targetPath.toLowerCase() &&
    existsInTree(vaultState.files, destinationPath)
  ) {
    cancelEdit();
    return;
  }

  setVaultState("editState", null);

  try {
    if (edit.kind === "create") {
      if (edit.isDir) {
        await vaultMkdir(destinationPath);
      } else {
        const finalPath = destinationPath.endsWith(".md")
          ? destinationPath
          : `${destinationPath}.md`;
        await writeVaultFile(finalPath, "");
      }
      await loadFiles(root);
      return;
    }

    await vaultRename(edit.targetPath, destinationPath);
    batch(() => {
      renameTabsForMovedPath(edit.targetPath, destinationPath, edit.isDir);
      applyMovedPathToVaultUiState(edit.targetPath, destinationPath, edit.isDir);
    });
    await loadFiles(root);
  } catch {
    // Intentionally silent: current UX exits edit mode without a dedicated error surface.
  }
}

function cancelEdit(): void {
  setVaultState("editState", null);
}

async function deleteEntry(path: string): Promise<void> {
  const root = vaultState.rootPath;
  if (!root) return;

  const entry = findInTree(vaultState.files, path);
  if (!entry) return;

  try {
    await vaultDelete(path, settingsState.files.deletedFiles as DeleteMode);
    batch(() => {
      closeTabsForDeletedPath(path, entry.is_directory);
      if (
        vaultState.editState &&
        isSameOrDescendantPath(vaultState.editState.targetPath, path, entry.is_directory)
      ) {
        cancelEdit();
      }
    });
    await loadFiles(root);
  } catch {
    // Intentionally silent: current delete UX has no dedicated error surface.
  }
}

function resolveMoveEntryToFolder(
  path: string,
  destinationFolderPath: string,
): { entry: FileEntry; nextParentPath: string; destinationPath: string } | null {
  const entry = findInTree(vaultState.files, path);
  if (!entry) return null;

  const nextParentPath = destinationFolderPath.trim();
  if (entry.is_directory && isSameOrDescendantPath(nextParentPath, entry.path, true)) {
    return null;
  }

  const destinationPath = joinVaultPath(nextParentPath, entry.name);
  if (destinationPath === entry.path) {
    return null;
  }

  if (existsInTree(vaultState.files, destinationPath)) {
    return null;
  }

  return {
    entry,
    nextParentPath,
    destinationPath,
  };
}

function canMoveEntryToFolder(path: string, destinationFolderPath: string): boolean {
  return resolveMoveEntryToFolder(path, destinationFolderPath) !== null;
}

async function moveEntryToFolder(path: string, destinationFolderPath: string): Promise<boolean> {
  const root = vaultState.rootPath;
  if (!root) return false;

  const move = resolveMoveEntryToFolder(path, destinationFolderPath);
  if (!move) return false;

  try {
    await vaultRename(move.entry.path, move.destinationPath);
    batch(() => {
      renameTabsForMovedPath(move.entry.path, move.destinationPath, move.entry.is_directory);
      setSelectedPath(move.entry.path);
      applyMovedPathToVaultUiState(move.entry.path, move.destinationPath, move.entry.is_directory);
      if (move.nextParentPath) {
        expandFolder(move.nextParentPath);
      }
    });
    await loadFiles(root);
    return true;
  } catch {
    return false;
  }
}

async function openTrashFolder(): Promise<void> {
  if (!vaultState.rootPath) return;

  try {
    await vaultMkdir(".trash");
    const trashPath = await vaultGetTrashPath(true);
    const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
    await revealItemInDir(trashPath);
  } catch {
    // Intentionally silent: settings action has no dedicated error surface yet.
  }
}

async function emptyTrashFolder(): Promise<void> {
  if (!vaultState.rootPath) return;

  try {
    await vaultEmptyTrash();
  } catch {
    // Intentionally silent: settings action has no dedicated error surface yet.
  }
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
  await vaultDelete(path, "permanent");
}

async function rename(from: string, to: string): Promise<void> {
  await vaultRename(from, to);
}

export {
  cancelEdit,
  clearConfiguredVault,
  closeVault,
  confirmEdit,
  createAndOpenNewFile,
  deleteEntry,
  exists,
  expandFolder,
  findInTree,
  getCreationFolder,
  isFolderExpanded,
  loadFiles,
  existsInTree,
  emptyTrashFolder,
  openTrashFolder,
  openVault,
  canMoveEntryToFolder,
  moveEntryToFolder,
  readFile,
  readFileWithChecksum,
  remove,
  rename,
  revealPath,
  setSelectedPath,
  selectVault,
  startCreateFile,
  startCreateFolder,
  startRename,
  startWatcher,
  stopWatcher,
  syncConfiguredVaultSelection,
  toggleFolder,
  updateEditName,
  vaultState,
  writeFile,
  writeFileWithChecksum,
};
export type { ConfiguredVaultStatus, EditState, RenameSurface, VaultState };
