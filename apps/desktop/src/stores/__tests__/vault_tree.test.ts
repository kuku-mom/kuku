import { describe, expect, it } from "vitest";

import type { FileEntry } from "~/lib/vault_fs";
import { buildVaultTreeIndex, reconcileVaultUiState } from "~/stores/vault_tree";

const FILES: FileEntry[] = [
  {
    name: "notes",
    path: "notes",
    is_directory: true,
    children: [
      {
        name: "a.md",
        path: "notes/a.md",
        is_directory: false,
      },
      {
        name: "archive",
        path: "notes/archive",
        is_directory: true,
        children: [],
      },
    ],
  },
];

describe("vault tree reconciliation", () => {
  it("builds file and directory path indexes", () => {
    const index = buildVaultTreeIndex(FILES);

    expect(index.allPaths.has("notes")).toBe(true);
    expect(index.allPaths.has("notes/a.md")).toBe(true);
    expect(index.directoryPaths.has("notes")).toBe(true);
    expect(index.directoryPaths.has("notes/archive")).toBe(true);
    expect(index.directoryPaths.has("notes/a.md")).toBe(false);
  });

  it("prunes missing expanded folders, selection, and edit targets", () => {
    const index = buildVaultTreeIndex(FILES);
    const next = reconcileVaultUiState(index, {
      expandedFolders: new Set(["notes", "notes/missing"]),
      selectedPath: "notes/missing.md",
      editState: {
        kind: "create",
        targetPath: "notes/missing",
        parentPath: "notes/missing",
        isDir: false,
        name: "draft.md",
        preservedExtension: null,
      },
    });

    expect([...next.expandedFolders]).toEqual(["notes"]);
    expect(next.selectedPath).toBeNull();
    expect(next.editState).toBeNull();
  });

  it("keeps root-level edit drafts even when no folder is selected", () => {
    const index = buildVaultTreeIndex(FILES);
    const next = reconcileVaultUiState(index, {
      expandedFolders: new Set(),
      selectedPath: null,
      editState: {
        kind: "create",
        targetPath: "",
        parentPath: "",
        isDir: true,
        name: "new-folder",
        preservedExtension: null,
      },
    });

    expect(next.editState).not.toBeNull();
    expect(next.editState?.parentPath).toBe("");
  });

  it("preserves UI state when tree casing drifts from stored paths", () => {
    // Simulate the window after a case-only rename where the UI hasn't been
    // remapped yet: the tree now holds `Notes/A.MD` but expandedFolders /
    // selectedPath / editState still reference the pre-rename casing. On
    // case-insensitive filesystems these refer to the same entry, so the
    // reconcile must keep them rather than treat them as orphans.
    const index = buildVaultTreeIndex([
      {
        name: "Notes",
        path: "Notes",
        is_directory: true,
        children: [
          {
            name: "A.MD",
            path: "Notes/A.MD",
            is_directory: false,
          },
          {
            name: "Archive",
            path: "Notes/Archive",
            is_directory: true,
            children: [],
          },
        ],
      },
    ]);

    const next = reconcileVaultUiState(index, {
      expandedFolders: new Set(["notes", "notes/archive"]),
      selectedPath: "notes/a.md",
      editState: {
        kind: "rename",
        surface: "browser",
        targetPath: "notes/a.md",
        parentPath: "notes",
        isDir: false,
        name: "a",
        preservedExtension: ".md",
      },
    });

    expect([...next.expandedFolders]).toEqual(["notes", "notes/archive"]);
    expect(next.selectedPath).toBe("notes/a.md");
    expect(next.editState).not.toBeNull();
  });

  it("drops rename edit state when the target path disappears", () => {
    const index = buildVaultTreeIndex(FILES);
    const next = reconcileVaultUiState(index, {
      expandedFolders: new Set(),
      selectedPath: null,
      editState: {
        kind: "rename",
        surface: "browser",
        targetPath: "notes/missing.md",
        parentPath: "notes",
        isDir: false,
        name: "missing",
        preservedExtension: ".md",
      },
    });

    expect(next.editState).toBeNull();
  });
});
