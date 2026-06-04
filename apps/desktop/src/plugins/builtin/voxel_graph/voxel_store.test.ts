import { describe, expect, it, vi } from "vitest";

import type { SearchService } from "../core_indexer/service";
import type { GraphSnapshot, IndexerStatus } from "../core_indexer/types";

import { createVoxelGraphStore } from "./voxel_store";

vi.mock("~/lib/vault_fs", () => ({
  readVaultFile: vi.fn().mockResolvedValue("linked note content"),
}));

vi.mock("~/stores/vault", () => ({
  vaultState: { files: [] },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createSearchService(
  snapshot: Promise<GraphSnapshot>,
  status: Promise<IndexerStatus>,
): SearchService {
  return {
    querySimple: vi.fn(),
    queryAdvanced: vi.fn(),
    requestRebuild: vi.fn(),
    getDebugStatus: vi.fn(),
    getGraphSnapshot: vi.fn(() => snapshot),
    resolveWikilink: vi.fn(),
    getConfig: vi.fn(),
    setConfig: vi.fn(),
    getStatus: vi.fn(() => status),
  };
}

describe("createVoxelGraphStore", () => {
  it("ignores in-flight graph results after clear", async () => {
    const snapshot = deferred<GraphSnapshot>();
    const status = deferred<IndexerStatus>();
    const store = createVoxelGraphStore({
      service: createSearchService(snapshot.promise, status.promise),
    });

    const build = store.buildGraphData();
    store.clear();

    snapshot.resolve({
      nodes: [
        {
          id: "notes/alpha.md",
          name: "Alpha",
          filePath: "notes/alpha.md",
          folder: "notes",
          clusterIndex: 0,
          linkCount: 0,
          isOrphan: true,
        },
      ],
      links: [],
      adjacencyMap: {
        "notes/alpha.md": [],
      },
      unresolvedCount: 0,
      ambiguousCount: 0,
    });
    status.resolve({
      state: "idle",
      totalDocs: 1,
      indexedDocs: 1,
      lastIndexedAt: 123,
      resolvedLinks: 0,
      unresolvedLinks: 0,
      ambiguousLinks: 0,
      error: null,
    });

    await build;

    expect(store.state.nodes).toEqual([]);
    expect(store.state.links).toEqual([]);
    expect(store.state.adjacencyMap).toEqual({});
    expect(store.state.lastIndexedAt).toBeNull();
  });
});
