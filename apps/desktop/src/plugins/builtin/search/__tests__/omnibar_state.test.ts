import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  closeSearchOmnibar,
  createOmnibarController,
  isSearchOmnibarOpen,
  openSearchOmnibar,
  resetSearchOmnibarState,
} from "../omnibar_state";
import { getSearchMode, resetSearchModeState } from "../search_mode_state";
import type { SearchService } from "../../core_indexer/service";

describe("createOmnibarController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetSearchOmnibarState();
    resetSearchModeState();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetSearchOmnibarState();
    resetSearchModeState();
  });

  it("tracks open and close state", () => {
    openSearchOmnibar();
    expect(isSearchOmnibarOpen()).toBe(true);
    expect(getSearchMode()).toBe("simple");

    closeSearchOmnibar();
    expect(isSearchOmnibarOpen()).toBe(false);
  });

  it("opens in advanced mode and searches through the advanced query path", async () => {
    const querySimple = vi.fn();
    const queryAdvanced = vi.fn().mockResolvedValue({ query: "alpha", total: 0, items: [] });
    const service: SearchService = {
      querySimple,
      queryAdvanced,
      getStatus: vi.fn(),
      getDebugStatus: vi.fn(),
      requestRebuild: vi.fn(),
      getGraphSnapshot: vi.fn(),
      resolveWikilink: vi.fn(),
      getConfig: vi.fn(),
      setConfig: vi.fn(),
    };

    await new Promise<void>((resolve, reject) => {
      createRoot((dispose) => {
        const controller = createOmnibarController(() => service);
        void (async () => {
          try {
            openSearchOmnibar("regex");
            expect(isSearchOmnibarOpen()).toBe(true);
            expect(controller.mode()).toBe("regex");

            controller.scheduleSearch("alpha");
            await vi.advanceTimersByTimeAsync(250);
            await Promise.resolve();

            expect(querySimple).not.toHaveBeenCalled();
            expect(queryAdvanced).toHaveBeenCalledWith({
              query: "alpha",
              caseSensitive: false,
            });

            dispose();
            resolve();
          } catch (error) {
            dispose();
            reject(error);
          }
        })();
      });
    });
  });

  it("updates selection with arrow-style movement", async () => {
    const service: SearchService = {
      querySimple: vi.fn().mockResolvedValue({
        query: "alpha",
        total: 2,
        items: [
          {
            docId: "a.md",
            title: "Alpha",
            sectionPath: [],
            sectionOrdinal: 0,
            snippet: "alpha",
            kind: "Title",
            score: 1,
          },
          {
            docId: "b.md",
            title: "Beta",
            sectionPath: ["Section"],
            sectionOrdinal: 0,
            snippet: "beta",
            kind: "Prose",
            score: 0,
          },
        ],
      }),
      queryAdvanced: vi.fn(),
      getStatus: vi.fn(),
      getDebugStatus: vi.fn(),
      requestRebuild: vi.fn(),
      getGraphSnapshot: vi.fn(),
      resolveWikilink: vi.fn(),
      getConfig: vi.fn(),
      setConfig: vi.fn(),
    };

    await new Promise<void>((resolve, reject) => {
      createRoot((dispose) => {
        const controller = createOmnibarController(() => service);
        void (async () => {
          try {
            controller.scheduleSearch("alpha");
            await vi.advanceTimersByTimeAsync(250);
            await Promise.resolve();
            await Promise.resolve();

            expect(controller.selectedIndex()).toBe(0);
            expect(controller.selectCurrent()?.docId).toBe("a.md");

            controller.moveSelection(1);
            expect(controller.selectedIndex()).toBe(1);
            expect(controller.selectCurrent()?.docId).toBe("b.md");

            controller.moveSelection(1);
            expect(controller.selectedIndex()).toBe(1);

            controller.moveSelection(-1);
            expect(controller.selectedIndex()).toBe(0);

            dispose();
            resolve();
          } catch (error) {
            dispose();
            reject(error);
          }
        })();
      });
    });
  });
});
