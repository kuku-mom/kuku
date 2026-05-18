import { beforeEach, describe, expect, it, vi } from "vitest";

const mockListVaultFiles = vi.fn();
const mockVaultRename = vi.fn();
const mockVaultDelete = vi.fn();
const mockVaultGetTrashPath = vi.fn();
const mockWriteVaultFile = vi.fn();
const mockListen = vi.fn().mockResolvedValue(() => {});
const mockGetActiveTab = vi.fn();
const mockOpenTab = vi.fn();
const mockGetEditorDocumentSession = vi.fn();
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
  filesState: { tabs: [], activeTabId: null },
  getActiveEditorFolder: vi.fn(() => ""),
  getActiveTab: mockGetActiveTab,
  openTab: mockOpenTab,
  reconcileEditorTabsWithVault: mockReconcileEditorTabsWithVault,
  renameTabsForMovedPath: mockRenameTabsForMovedPath,
  requestEditorFocusForTab: vi.fn(),
}));

vi.mock("~/stores/editor", () => ({
  getEditorDocumentSession: mockGetEditorDocumentSession,
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
  vaultRename: mockVaultRename,
  writeVaultFile: mockWriteVaultFile,
  writeVaultFileWithChecksum: vi.fn(),
}));

async function loadVaultModule() {
  vi.resetModules();
  return import("~/stores/vault");
}

function emitVaultFileChanged(
  handler: ((event: { payload: unknown }) => void) | null,
  payload: unknown,
): void {
  if (!handler) {
    throw new Error("vault:file-changed listener was not registered");
  }
  handler({ payload });
}

describe("vault actions", () => {
  beforeEach(() => {
    mockListVaultFiles.mockReset().mockResolvedValue(FILES);
    mockVaultRename.mockReset().mockResolvedValue(undefined);
    mockVaultDelete.mockReset().mockResolvedValue(undefined);
    mockVaultGetTrashPath.mockReset().mockResolvedValue("/tmp/vault/.trash");
    mockWriteVaultFile.mockReset().mockResolvedValue(undefined);
    mockGetActiveTab.mockReset().mockReturnValue(undefined);
    mockOpenTab.mockReset();
    mockGetEditorDocumentSession.mockReset().mockReturnValue(null);
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

  it("reloads the clean active editor when a watcher event modifies its file", async () => {
    const reloadFromDisk = vi.fn().mockResolvedValue({ status: "skipped", reason: "unchanged" });
    let handleChange: ((event: { payload: unknown }) => void) | null = null;
    mockListen.mockImplementationOnce(
      async (_eventName: string, handler: (event: { payload: unknown }) => void) => {
        handleChange = handler;
        return () => {};
      },
    );
    mockGetActiveTab.mockReturnValue({
      id: "tab-1",
      fileName: "a.md",
      filePath: "notes/a.md",
      type: "editor",
      isDirty: false,
    });
    mockGetEditorDocumentSession.mockReturnValue({
      tabId: "tab-1",
      filePath: "notes/a.md",
      save: vi.fn(),
      reloadFromDisk,
      getChecksum: vi.fn(),
    });
    const vault = await loadVaultModule();

    await vault.startWatcher();
    emitVaultFileChanged(handleChange, { kind: "modify", path: "notes/a.md", is_dir: false });
    await vault.stopWatcher();

    expect(mockGetEditorDocumentSession).toHaveBeenCalledWith("notes/a.md");
    expect(reloadFromDisk).toHaveBeenCalledTimes(1);
  });

  it("does not reload the active editor when the tab is dirty", async () => {
    const reloadFromDisk = vi.fn();
    let handleChange: ((event: { payload: unknown }) => void) | null = null;
    mockListen.mockImplementationOnce(
      async (_eventName: string, handler: (event: { payload: unknown }) => void) => {
        handleChange = handler;
        return () => {};
      },
    );
    mockGetActiveTab.mockReturnValue({
      id: "tab-1",
      fileName: "a.md",
      filePath: "notes/a.md",
      type: "editor",
      isDirty: true,
    });
    mockGetEditorDocumentSession.mockReturnValue({
      tabId: "tab-1",
      filePath: "notes/a.md",
      save: vi.fn(),
      reloadFromDisk,
      getChecksum: vi.fn(),
    });
    const vault = await loadVaultModule();

    await vault.startWatcher();
    emitVaultFileChanged(handleChange, { kind: "modify", path: "notes/a.md", is_dir: false });
    await vault.stopWatcher();

    expect(mockGetEditorDocumentSession).not.toHaveBeenCalled();
    expect(reloadFromDisk).not.toHaveBeenCalled();
  });

  it("moves a file into another folder path", async () => {
    const vault = await loadVaultModule();

    await vault.loadFiles("/tmp/vault");
    expect(vault.canMoveEntryToFolder("notes/a.md", "")).toBe(true);
    const moved = await vault.moveEntryToFolder("notes/a.md", "");

    expect(moved).toBe(true);
    expect(mockVaultRename).toHaveBeenCalledWith("notes/a.md", "a.md");
    expect(mockRenameTabsForMovedPath).toHaveBeenCalledWith("notes/a.md", "a.md", false);
  });

  it("rejects moving a folder into itself", async () => {
    const vault = await loadVaultModule();

    await vault.loadFiles("/tmp/vault");
    expect(vault.canMoveEntryToFolder("notes", "notes")).toBe(false);
    const moved = await vault.moveEntryToFolder("notes", "notes");

    expect(moved).toBe(false);
    expect(mockVaultRename).not.toHaveBeenCalled();
    expect(mockRenameTabsForMovedPath).not.toHaveBeenCalled();
  });

  it("case-only renames a folder and propagates the new casing to child tabs", async () => {
    // `notes/` → `NOTES/` on APFS is a real on-disk change. The rename flow
    // must call through to `vault_rename` and tell the tabs store to remap
    // descendants so the next vault reconcile doesn't drop them.
    const vault = await loadVaultModule();

    await vault.loadFiles("/tmp/vault");
    vault.startRename("notes");
    vault.updateEditName("NOTES");
    await vault.confirmEdit();

    expect(mockVaultRename).toHaveBeenCalledWith("notes", "NOTES");
    expect(mockRenameTabsForMovedPath).toHaveBeenCalledWith("notes", "NOTES", true);
  });

  it("finds entries using case-insensitive paths after a folder rename", async () => {
    // Simulate post-rename state: the tree is authoritative and now uses
    // uppercase casing, but a caller (stale tab, vault browser event fired
    // before the UI refresh, etc.) still references the pre-rename path.
    // findInTree must resolve via case-insensitive lookup so rename /
    // delete don't silently no-op.
    mockListVaultFiles.mockResolvedValueOnce([
      {
        name: "NOTES",
        path: "NOTES",
        is_directory: true,
        children: [
          {
            name: "a.md",
            path: "NOTES/a.md",
            is_directory: false,
          },
        ],
      },
    ]);
    const vault = await loadVaultModule();

    await vault.loadFiles("/tmp/vault");
    vault.startRename("notes/a.md");

    // editState carries the tree's canonical casing, not the caller's input.
    expect(vault.vaultState.editState).toMatchObject({
      kind: "rename",
      targetPath: "NOTES/a.md",
      parentPath: "NOTES",
      name: "a",
      preservedExtension: ".md",
    });
  });

  it("deletes a child file when the caller path differs only in case", async () => {
    mockListVaultFiles.mockResolvedValueOnce([
      {
        name: "NOTES",
        path: "NOTES",
        is_directory: true,
        children: [
          {
            name: "a.md",
            path: "NOTES/a.md",
            is_directory: false,
          },
        ],
      },
    ]);
    const vault = await loadVaultModule();

    await vault.loadFiles("/tmp/vault");
    // Caller passes the old casing — `findInTree` must still match so the
    // delete propagates to Rust and the tab-close cascade.
    await vault.deleteEntry("notes/a.md");

    expect(mockVaultDelete).toHaveBeenCalledWith("notes/a.md", "trash");
    expect(mockCloseTabsForDeletedPath).toHaveBeenCalledWith("notes/a.md", false);
  });

  it("creates demo vault sample files and opens the start note", async () => {
    mockListVaultFiles.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        name: "Start Here.md",
        path: "Start Here.md",
        is_directory: false,
      },
    ]);
    const vault = await loadVaultModule();

    await vault.loadFiles("/tmp/vault");
    await vault.createDemoVaultSamples();

    expect(mockWriteVaultFile).toHaveBeenCalledWith(
      "Start Here.md",
      expect.stringContaining("[[Notes/Wikilinks.md|wikilinks]]"),
    );
    expect(mockWriteVaultFile).toHaveBeenCalledWith(
      "Notes/AI Workflows.md",
      expect.stringContaining("Draft a wiki-style summary"),
    );
    expect(mockOpenTab).toHaveBeenCalledWith("Start Here.md", "Start Here.md", "editor");
  });
});
