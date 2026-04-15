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
  const expandedFolders = new Set(
    [...current.expandedFolders].filter((path) => index.directoryPaths.has(path)),
  );

  const selectedPath =
    current.selectedPath && index.allPaths.has(current.selectedPath) ? current.selectedPath : null;

  const editState =
    current.editState &&
    (current.editState.parentPath === "" ||
      index.directoryPaths.has(current.editState.parentPath)) &&
    (current.editState.kind === "create" || index.allPaths.has(current.editState.targetPath))
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
