import { describe, expect, it, vi } from "vitest";

import type { SearchService } from "../core_indexer/service";

import { createGraphStore } from "./graph_store";

function createSearchService(): SearchService {
  return {
    querySimple: vi.fn(),
    queryAdvanced: vi.fn(),
    requestRebuild: vi.fn(),
    getDebugStatus: vi.fn(),
    getGraphSnapshot: vi.fn().mockResolvedValue({
      nodes: [
        {
          id: "notes/alpha.md",
          name: "Alpha",
          filePath: "notes/alpha.md",
          folder: "notes",
          clusterIndex: 0,
          linkCount: 1,
          isOrphan: false,
        },
        {
          id: "notes/beta.md",
          name: "Beta",
          filePath: "notes/beta.md",
          folder: "notes",
          clusterIndex: 0,
          linkCount: 1,
          isOrphan: false,
        },
      ],
      links: [{ source: "notes/alpha.md", target: "notes/beta.md" }],
      adjacencyMap: {
        "notes/alpha.md": ["notes/beta.md"],
        "notes/beta.md": ["notes/alpha.md"],
      },
      unresolvedCount: 0,
      ambiguousCount: 0,
    }),
    resolveWikilink: vi.fn(),
    getConfig: vi.fn(),
    setConfig: vi.fn(),
    getStatus: vi.fn().mockResolvedValue({
      state: "idle",
      totalDocs: 2,
      indexedDocs: 2,
      lastIndexedAt: 123,
      resolvedLinks: 1,
      unresolvedLinks: 0,
      ambiguousLinks: 0,
      error: null,
    }),
  };
}

describe("createGraphStore", () => {
  it("hydrates graph state from the indexer snapshot", async () => {
    const store = createGraphStore({ service: createSearchService() });

    await store.buildGraphData();

    expect(store.state.nodes).toHaveLength(2);
    expect(store.state.links).toEqual([{ source: "notes/alpha.md", target: "notes/beta.md" }]);
    expect(store.state.adjacencyMap["notes/alpha.md"]).toEqual(["notes/beta.md"]);
    expect(store.state.clusters).toEqual(["notes"]);
    expect(store.state.isIndexing).toBe(false);
    expect(store.state.lastIndexedAt).toBe(123);
    expect(store.state.error).toBeNull();
  });
});
