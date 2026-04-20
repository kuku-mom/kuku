import type { FileEntry } from "~/lib/vault_fs";

interface BaseEditStateLike {
  targetPath: string;
  parentPath: string;
  isDir: boolean;
  name: string;
  preservedExtension: string | null;
}

interface CreateEditStateLike extends BaseEditStateLike {
  kind: "create";
}

interface RenameEditStateLike extends BaseEditStateLike {
  kind: "rename";
  surface: "browser" | "tab";
}

type EditStateLike = CreateEditStateLike | RenameEditStateLike;

interface VaultTreeIndex {
  allPaths: Set<string>;
  directoryPaths: Set<string>;
}

interface VaultUiStateLike {
  expandedFolders: Set<string>;
  selectedPath: string | null;
  editState: EditStateLike | null;
}

function buildVaultTreeIndex(entries: FileEntry[]): VaultTreeIndex {
  const allPaths = new Set<string>();
  const directoryPaths = new Set<string>();

  const visit = (nodes: FileEntry[]) => {
    for (const entry of nodes) {
      allPaths.add(entry.path);
      if (entry.is_directory) {
        directoryPaths.add(entry.path);
        visit(entry.children ?? []);
      }
    }
  };

  visit(entries);

  return { allPaths, directoryPaths };
}

function reconcileVaultUiState(index: VaultTreeIndex, current: VaultUiStateLike): VaultUiStateLike {
  // Case-insensitive existence checks. UI state (expandedFolders,
  // selectedPath, editState.targetPath) may carry a different casing from
  // the on-disk entries (case-only rename, external editors that normalize
  // filenames, etc.). On case-insensitive filesystems those still refer to
  // the same entry — dropping them would lose legitimate UI state.
  const allPathsLower = new Set<string>();
  for (const path of index.allPaths) allPathsLower.add(path.toLowerCase());
  const directoryPathsLower = new Set<string>();
  for (const path of index.directoryPaths) directoryPathsLower.add(path.toLowerCase());

  const expandedFolders = new Set(
    [...current.expandedFolders].filter((path) => directoryPathsLower.has(path.toLowerCase())),
  );

  const selectedPath =
    current.selectedPath && allPathsLower.has(current.selectedPath.toLowerCase())
      ? current.selectedPath
      : null;

  const editState =
    current.editState &&
    (current.editState.parentPath === "" ||
      directoryPathsLower.has(current.editState.parentPath.toLowerCase())) &&
    (current.editState.kind === "create" ||
      allPathsLower.has(current.editState.targetPath.toLowerCase()))
      ? current.editState
      : null;

  return {
    expandedFolders,
    selectedPath,
    editState,
  };
}

export { buildVaultTreeIndex, reconcileVaultUiState };
export type { EditStateLike, VaultTreeIndex, VaultUiStateLike };
