import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isFullscreen: vi.fn().mockResolvedValue(false),
    onResized: vi.fn().mockResolvedValue(() => {}),
  }),
}));

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
  const storage = new StorageMock();

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      innerWidth: 1440,
      innerHeight: 900,
    },
  });

  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage,
  });

  return storage;
}

async function loadLayoutModule() {
  vi.resetModules();
  return import("~/stores/layout");
}

describe("layout right panel host state", () => {
  beforeEach(() => {
    installBrowserGlobals();
  });

  it("opens the right panel and stores the active view", async () => {
    const layout = await loadLayoutModule();

    layout.openRightPanelView("graph-view.panel");

    expect(layout.layoutState.rightPanelOpen).toBe(true);
    expect(layout.layoutState.activeRightPanelViewId).toBe("graph-view.panel");
  });

  it("keeps the active view when the panel is toggled closed and open again", async () => {
    const layout = await loadLayoutModule();

    layout.openRightPanelView("graph-view.panel");
    layout.toggleRightPanel();

    expect(layout.layoutState.rightPanelOpen).toBe(false);
    expect(layout.layoutState.activeRightPanelViewId).toBe("graph-view.panel");

    layout.toggleRightPanel();

    expect(layout.layoutState.rightPanelOpen).toBe(true);
    expect(layout.layoutState.activeRightPanelViewId).toBe("graph-view.panel");
  });

  it("clears the active view only when closeRightPanelView is used", async () => {
    const layout = await loadLayoutModule();

    layout.openRightPanelView("graph-view.panel");
    layout.closeRightPanelView();

    expect(layout.layoutState.rightPanelOpen).toBe(false);
    expect(layout.layoutState.activeRightPanelViewId).toBeNull();
  });

  it("restores the last active right panel view from localStorage", async () => {
    const storage = installBrowserGlobals();

    storage.setItem(
      "layout-state",
      JSON.stringify({
        rightPanelOpen: false,
        activeRightPanelViewId: "graph-view.panel",
      }),
    );

    const layout = await loadLayoutModule();

    expect(layout.layoutState.rightPanelOpen).toBe(false);
    expect(layout.layoutState.activeRightPanelViewId).toBe("graph-view.panel");
  });
});
