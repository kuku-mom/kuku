import { beforeEach, describe, expect, it, vi } from "vitest";

class StorageMock {
  readonly #store = new Map<string, string>();

  clear(): void {
    this.#store.clear();
  }

  getItem(key: string): string | null {
    return this.#store.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.#store.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.#store.delete(key);
  }

  setItem(key: string, value: string): void {
    this.#store.set(key, value);
  }

  get length(): number {
    return this.#store.size;
  }
}

function installBrowserGlobals() {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: new StorageMock(),
  });

  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: {
      randomUUID: vi
        .fn()
        .mockReturnValueOnce("tab-1")
        .mockReturnValueOnce("tab-2")
        .mockReturnValue("tab-next"),
    },
  });
}

async function loadFilesModule() {
  vi.resetModules();
  return import("~/stores/files");
}

describe("files settings dialog state", () => {
  beforeEach(() => {
    installBrowserGlobals();
  });

  it("opens settings as a dialog without creating a center tab", async () => {
    const files = await loadFilesModule();

    files.openTab("Note", "Note.md", "editor");
    files.openSettings({ kind: "category", categoryId: "appearance" });

    expect(files.filesState.tabs).toHaveLength(1);
    expect(files.filesState.tabs[0]).toMatchObject({
      id: "tab-1",
      type: "editor",
      filePath: "Note.md",
    });
    expect(files.filesState.settingsDialogOpen).toBe(true);
    expect(files.filesState.settingsTarget).toEqual({
      kind: "category",
      categoryId: "appearance",
    });
  });

  it("routes legacy settings tabs through the dialog API", async () => {
    const files = await loadFilesModule();

    files.openTab("Settings", null, "settings");

    expect(files.filesState.tabs).toHaveLength(0);
    expect(files.filesState.settingsDialogOpen).toBe(true);
  });

  it("closes the settings dialog without changing the active editor tab", async () => {
    const files = await loadFilesModule();

    files.openTab("Note", "Note.md", "editor");
    files.openSettings();

    files.closeSettings();

    expect(files.filesState.activeTabId).toBe("tab-1");
    expect(files.filesState.settingsDialogOpen).toBe(false);
    expect(files.filesState.settingsTarget).toBeUndefined();
  });

  it("drops legacy persisted settings tabs on startup", async () => {
    localStorage.setItem(
      "tabs-state",
      JSON.stringify({
        tabs: [
          {
            fileName: "Settings",
            filePath: "",
            type: "settings",
          },
          {
            fileName: "Note",
            filePath: "Note.md",
            type: "editor",
          },
        ],
        activeFilePath: "",
      }),
    );

    const files = await loadFilesModule();

    expect(files.filesState.tabs).toHaveLength(1);
    expect(files.filesState.tabs[0]).toMatchObject({
      id: "tab-1",
      type: "editor",
      filePath: "Note.md",
    });
    expect(files.filesState.activeTabId).toBe("tab-1");
    expect(files.filesState.settingsDialogOpen).toBe(false);
  });

  it("opens a non-persisted placeholder tab without a file path", async () => {
    const files = await loadFilesModule();

    files.openTab("Note", "Note.md", "editor");
    files.openNewTabPlaceholder();

    expect(files.filesState.tabs).toHaveLength(2);
    expect(files.filesState.tabs[1]).toMatchObject({
      id: "tab-2",
      fileName: "New Tab",
      filePath: null,
      type: "placeholder",
    });
    expect(files.filesState.activeTabId).toBe("tab-2");

    files.openNewTabPlaceholder();

    expect(files.filesState.tabs).toHaveLength(2);
    expect(files.filesState.activeTabId).toBe("tab-2");
    expect(JSON.parse(localStorage.getItem("tabs-state") ?? "{}")).toMatchObject({
      tabs: [
        {
          fileName: "Note",
          filePath: "Note.md",
          type: "editor",
        },
      ],
      activeFilePath: null,
    });
  });

  it("replaces the active placeholder when opening a real tab", async () => {
    const files = await loadFilesModule();

    files.openNewTabPlaceholder();
    files.openTab("Note", "Note.md", "editor");

    expect(files.filesState.tabs).toHaveLength(1);
    expect(files.filesState.tabs[0]).toMatchObject({
      id: "tab-2",
      type: "editor",
      filePath: "Note.md",
    });
    expect(files.filesState.activeTabId).toBe("tab-2");
  });
});
