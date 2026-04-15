import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { onEvent } from "~/plugins/events";

import { indexerStatus, resetIndexerStatus, startStatusPolling } from "../status_store";
import type { SearchService } from "../service";

describe("startStatusPolling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetIndexerStatus();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("updates the store from the polling service", async () => {
    const service: SearchService = {
      querySimple: vi.fn(),
      queryAdvanced: vi.fn(),
      requestRebuild: vi.fn(),
      getGraphSnapshot: vi.fn(),
      resolveWikilink: vi.fn(),
      getConfig: vi.fn(),
      setConfig: vi.fn(),
      getStatus: vi.fn().mockResolvedValue({
        state: "indexing",
        totalDocs: 10,
        indexedDocs: 3,
        lastIndexedAt: null,
        resolvedLinks: 4,
        unresolvedLinks: 1,
        ambiguousLinks: 0,
        error: null,
      }),
    };

    const dispose = startStatusPolling(service);
    await Promise.resolve();
    await Promise.resolve();

    expect(indexerStatus.state).toBe("indexing");
    expect(indexerStatus.totalDocs).toBe(10);
    expect(indexerStatus.indexedDocs).toBe(3);

    dispose();
  });

  it("emits an indexer update when lastIndexedAt changes", async () => {
    const updates: number[] = [];
    const stopListening = onEvent("indexer:updated", (status) => {
      if (status.lastIndexedAt !== null) {
        updates.push(status.lastIndexedAt);
      }
    });
    const service: SearchService = {
      querySimple: vi.fn(),
      queryAdvanced: vi.fn(),
      requestRebuild: vi.fn(),
      getGraphSnapshot: vi.fn(),
      resolveWikilink: vi.fn(),
      getConfig: vi.fn(),
      setConfig: vi.fn(),
      getStatus: vi.fn().mockResolvedValue({
        state: "idle",
        totalDocs: 1,
        indexedDocs: 1,
        lastIndexedAt: 123,
        resolvedLinks: 0,
        unresolvedLinks: 0,
        ambiguousLinks: 0,
        error: null,
      }),
    };

    const dispose = startStatusPolling(service);
    await Promise.resolve();
    await Promise.resolve();

    expect(updates).toEqual([123]);

    dispose();
    stopListening();
  });
});
