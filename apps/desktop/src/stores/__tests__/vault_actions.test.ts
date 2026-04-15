import { beforeEach, describe, expect, it, vi } from "vitest";

const mockListVaultFiles = vi.fn();
const mockVaultRename = vi.fn();
const mockVaultDelete = vi.fn();
const mockVaultRemove = vi.fn();
const mockVaultGetTrashPath = vi.fn();
const mockListen = vi.fn().mockResolvedValue(() => {});
const mockRenameTabsForMovedPath = vi.fn();
const mockCloseTabsForDeletedPath = vi.fn();
const mockReconcileEditorTabsWithVault = vi.fn();
const mockSettingsState = {
  files: {
    deletedFiles: "trash",
  },
};

const FILES = [
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
        name: "b.md",
        path: "notes/b.md",
        is_directory: false,
      },
    ],
  },
];

vi.mock("@tauri-apps/api/event", () => ({
  listen: mockListen,
}));

vi.mock("~/stores/files", () => ({
  clearEditorTabs: vi.fn(),
  closeTabsForDeletedPath: mockCloseTabsForDeletedPath,
  reconcileEditorTabsWithVault: mockReconcileEditorTabsWithVault,
  renameTabsForMovedPath: mockRenameTabsForMovedPath,
}));

vi.mock("~/stores/settings", () => ({
  setTopLevelSetting: vi.fn(),
  settingsState: mockSettingsState,
}));

vi.mock("~/lib/vault_fs", () => ({
  closeVault: vi.fn(),
  listVaultFiles: mockListVaultFiles,
  openVault: vi.fn(),
  readVaultFile: vi.fn(),
  readVaultFileWithChecksum: vi.fn(),
  vaultExists: vi.fn(),
  vaultDelete: mockVaultDelete,
  vaultGetTrashPath: mockVaultGetTrashPath,
  vaultMkdir: vi.fn(),
  vaultRemove: mockVaultRemove,
  vaultRename: mockVaultRename,
  writeVaultFile: vi.fn(),
  writeVaultFileWithChecksum: vi.fn(),
}));

async function loadVaultModule() {
  vi.resetModules();
  return import("~/stores/vault");
}

describe("vault actions", () => {
  beforeEach(() => {
    mockListVaultFiles.mockReset().mockResolvedValue(FILES);
    mockVaultRename.mockReset().mockResolvedValue(undefined);
    mockVaultDelete.mockReset().mockResolvedValue(undefined);
    mockVaultRemove.mockReset().mockResolvedValue(undefined);
    mockVaultGetTrashPath.mockReset().mockResolvedValue("/tmp/vault/.trash");
    mockRenameTabsForMovedPath.mockReset();
    mockCloseTabsForDeletedPath.mockReset();
    mockReconcileEditorTabsWithVault.mockReset();
    mockListen.mockClear();
    mockSettingsState.files.deletedFiles = "trash";
  });

  it("starts file rename with basename-only editing", async () => {
    const vault = await loadVaultModule();

    await vault.loadFiles("/tmp/vault");
    vault.startRename("notes/a.md");

    expect(vault.vaultState.editState).toMatchObject({
      kind: "rename",
      surface: "browser",
      targetPath: "notes/a.md",
      parentPath: "notes",
      name: "a",
      preservedExtension: ".md",
    });
  });

  it("can start rename from the tab surface", async () => {
    const vault = await loadVaultModule();

    await vault.loadFiles("/tmp/vault");
    vault.startRename("notes/a.md", "tab");

    expect(vault.vaultState.editState).toMatchObject({
      kind: "rename",
      surface: "tab",
      targetPath: "notes/a.md",
      parentPath: "notes",
      name: "a",
      preservedExtension: ".md",
    });
  });

  it("exits rename edit mode when the next basename is empty", async () => {
    const vault = await loadVaultModule();

    await vault.loadFiles("/tmp/vault");
    vault.startRename("notes/a.md");
    vault.updateEditName("   ");
    await vault.confirmEdit();

    expect(vault.vaultState.editState).toBeNull();
    expect(mockVaultRename).not.toHaveBeenCalled();
  });

  it("exits rename edit mode when the next basename is unchanged", async () => {
    const vault = await loadVaultModule();

    await vault.loadFiles("/tmp/vault");
    vault.startRename("notes/a.md");
    vault.updateEditName("a");
    await vault.confirmEdit();

    expect(vault.vaultState.editState).toBeNull();
    expect(mockVaultRename).not.toHaveBeenCalled();
    expect(mockRenameTabsForMovedPath).not.toHaveBeenCalled();
  });

  it("exits rename edit mode when the destination path already exists", async () => {
    const vault = await loadVaultModule();

    await vault.loadFiles("/tmp/vault");
    vault.startRename("notes/a.md");
    vault.updateEditName("b");
    await vault.confirmEdit();

    expect(vault.vaultState.editState).toBeNull();
    expect(mockVaultRename).not.toHaveBeenCalled();
    expect(mockRenameTabsForMovedPath).not.toHaveBeenCalled();
  });

  it("exits rename edit mode when the edited basename contains path separators", async () => {
    const vault = await loadVaultModule();

    await vault.loadFiles("/tmp/vault");
    vault.startRename("notes/a.md");
    vault.updateEditName("archive/a");
    await vault.confirmEdit();

    expect(vault.vaultState.editState).toBeNull();
    expect(mockVaultRename).not.toHaveBeenCalled();
    expect(mockRenameTabsForMovedPath).not.toHaveBeenCalled();
  });

  it("keeps tabs and edit state intact when delete fails", async () => {
    const vault = await loadVaultModule();
    mockVaultDelete.mockRejectedValueOnce(new Error("permission denied"));

    await vault.loadFiles("/tmp/vault");
    vault.startRename("notes/a.md");
    await vault.deleteEntry("notes/a.md");

    expect(mockCloseTabsForDeletedPath).not.toHaveBeenCalled();
    expect(vault.vaultState.editState).toMatchObject({
      kind: "rename",
      targetPath: "notes/a.md",
    });
  });

  it("uses the configured delete mode", async () => {
    const vault = await loadVaultModule();
    mockSettingsState.files.deletedFiles = "kuku-trash";

    await vault.loadFiles("/tmp/vault");
    await vault.deleteEntry("notes/a.md");

    expect(mockVaultDelete).toHaveBeenCalledWith("notes/a.md", "kuku-trash");
    expect(mockCloseTabsForDeletedPath).toHaveBeenCalledWith("notes/a.md", false);
  });
});
