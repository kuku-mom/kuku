import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSearchTabController } from "../search_tab_state";
import { resetSearchModeState } from "../search_mode_state";
import type { SearchService } from "../../core_indexer/service";
import { emitEvent } from "~/plugins/events";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("createSearchTabController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetSearchModeState();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetSearchModeState();
  });

  it("drops stale responses using sequence ids", async () => {
    const first = deferred<{ query: string; total: number; items: never[] }>();
    const second = deferred<{ query: string; total: number; items: never[] }>();

    const querySimple = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);

    const service: SearchService = {
      querySimple,
      queryAdvanced: vi.fn(),
      getStatus: vi.fn(),
      getDebugStatus: vi.fn(),
      requestRebuild: vi.fn(),
      getGraphSnapshot: vi.fn(),
      resolveWikilink: vi.fn(),
      getConfig: vi.fn(),
      setConfig: vi.fn(),
    };

    await new Promise<void>((resolve) => {
      createRoot((dispose) => {
        const controller = createSearchTabController(() => service);
        controller.scheduleSearch("first");
        void vi
          .advanceTimersByTimeAsync(250)
          .then(() => {
            controller.scheduleSearch("second");
            return vi.advanceTimersByTimeAsync(250);
          })
          .then(async () => {
            second.resolve({ query: "second", total: 0, items: [] });
            await Promise.resolve();
            first.resolve({ query: "first", total: 0, items: [] });
            await Promise.resolve();
            expect(controller.results()?.query).toBe("second");
            dispose();
            resolve();
          });
      });
    });
  });

  it("clears the active query and results when the vault changes", async () => {
    const service: SearchService = {
      querySimple: vi.fn().mockResolvedValue({ query: "note", total: 1, items: [] }),
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
        const controller = createSearchTabController(() => service);
        void (async () => {
          try {
            controller.scheduleSearch("note");
            await vi.advanceTimersByTimeAsync(250);
            await Promise.resolve();
            await Promise.resolve();
            expect(controller.query()).toBe("note");
            expect(controller.results()?.query).toBe("note");

            emitEvent("vault:opened", { rootPath: "/vault-b" });

            expect(controller.query()).toBe("");
            expect(controller.results()).toBeNull();
            expect(controller.error()).toBeNull();
            expect(controller.isLoading()).toBe(false);

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

  it("switches to regex mode and calls the advanced query path", async () => {
    const querySimple = vi.fn().mockResolvedValue({ query: "note", total: 0, items: [] });
    const queryAdvanced = vi.fn().mockResolvedValue({ query: "note", total: 0, items: [] });
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
        const controller = createSearchTabController(() => service);
        void (async () => {
          try {
            controller.scheduleSearch("note");
            await vi.advanceTimersByTimeAsync(250);
            await Promise.resolve();

            controller.setMode("regex");
            await vi.advanceTimersByTimeAsync(250);
            await Promise.resolve();

            expect(querySimple).toHaveBeenCalledTimes(1);
            expect(queryAdvanced).toHaveBeenCalledWith({
              query: "note",
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

  it("clears stale results on regex errors and recovers on simple search", async () => {
    const service: SearchService = {
      querySimple: vi.fn().mockResolvedValue({ query: "alpha", total: 1, items: [] }),
      queryAdvanced: vi.fn().mockRejectedValue(new Error("Invalid regex: (")),
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
        const controller = createSearchTabController(() => service);
        void (async () => {
          try {
            controller.setMode("regex");
            controller.scheduleSearch("(");
            await vi.advanceTimersByTimeAsync(250);
            await Promise.resolve();
            await Promise.resolve();

            expect(controller.results()).toBeNull();
            expect(controller.error()).toContain("Invalid regex");

            controller.setMode("simple");
            controller.scheduleSearch("alpha");
            await vi.advanceTimersByTimeAsync(250);
            await Promise.resolve();
            await Promise.resolve();

            expect(controller.error()).toBeNull();
            expect(controller.results()?.query).toBe("alpha");

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
