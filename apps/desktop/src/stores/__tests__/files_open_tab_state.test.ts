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

function installStorage(): void {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: new StorageMock(),
  });
}

async function loadFilesModule() {
  vi.resetModules();
  return import("~/stores/files");
}

describe("openTab state", () => {
  beforeEach(() => {
    installStorage();
  });

  it("stores state on singleton tabs and refreshes it when the tab already exists", async () => {
    const files = await loadFilesModule();

    files.openTab("Agent World", null, "voxel-graph", {
      focusFilePath: "notes/first.md",
    });

    expect(files.filesState.tabs).toHaveLength(1);
    expect(files.getActiveTab()?.state?.focusFilePath).toBe("notes/first.md");

    files.openTab("Agent World", null, "voxel-graph", {
      focusFilePath: "notes/second.md",
    });

    expect(files.filesState.tabs).toHaveLength(1);
    expect(files.getActiveTab()?.state?.focusFilePath).toBe("notes/second.md");

    files.openTab("Agent World", null, "voxel-graph", {
      focusFilePath: null,
    });

    expect(files.filesState.tabs).toHaveLength(1);
    expect(files.getActiveTab()?.state?.focusFilePath).toBeNull();
  });
});
