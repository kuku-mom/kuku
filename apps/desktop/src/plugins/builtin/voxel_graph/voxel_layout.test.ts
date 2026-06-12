import { describe, expect, it } from "vitest";

import type { GraphNode, GraphState } from "~/plugins/builtin/graph_view/graph_types";

import {
  BLOCK,
  agentWorldRestoreKey,
  computeIslands,
  computePlots,
  getVoxelVisibleStats,
  islandForNode,
  plotTierForNode,
} from "./voxel_layout";

function node(index: number, overrides: Partial<GraphNode> = {}): GraphNode {
  const folder = `team-${index}`;
  return {
    id: `node-${index}`,
    name: `Node ${index}`,
    filePath: `team-${index}/node-${index}.md`,
    folder,
    clusterIndex: index,
    linkCount: 0,
    isOrphan: true,
    ...overrides,
  };
}

function graphState(nodes: GraphNode[], links: GraphState["links"] = []): GraphState {
  const adjacencyMap: Record<string, string[]> = {};
  for (const item of nodes) adjacencyMap[item.filePath] = [];
  for (const link of links) {
    adjacencyMap[link.source]?.push(link.target);
    adjacencyMap[link.target]?.push(link.source);
  }

  return {
    nodes,
    links,
    adjacencyMap,
    clusters: nodes.map((item) => item.folder),
    isIndexing: false,
    lastIndexedAt: 1,
    error: null,
  };
}

describe("agent world layout", () => {
  it("creates one island per cluster and preserves original cluster indexes", () => {
    const nodes = [
      node(17, { folder: "제품/기획", clusterIndex: 17 }),
      node(999, { folder: "연구/AI", clusterIndex: 999 }),
    ];
    const clusters = Array.from({ length: 1_000 }, (_, index) => `folder-${index}`);
    clusters[17] = "제품/기획";
    clusters[999] = "연구/AI";

    const islands = computeIslands(nodes, clusters);

    expect(islands.map((island) => island.clusterIndex).sort((a, b) => a - b)).toEqual([17, 999]);
    expect(islandForNode(nodes[1], islands).clusterIndex).toBe(999);
    expect(islandForNode(nodes[1], islands).name).toBe("연구/AI");
  });

  it("keeps an empty root island for loading and empty states", () => {
    const islands = computeIslands([], []);

    expect(islands).toHaveLength(1);
    expect(islands[0].clusterIndex).toBe(0);
    expect(islands[0].name).toBe("Root");
  });

  it("places islands without overlap", () => {
    const nodes = Array.from({ length: 120 }, (_, index) =>
      node(index, { clusterIndex: index % 8, folder: `folder-${index % 8}` }),
    );
    const clusters = Array.from({ length: 8 }, (_, index) => `folder-${index}`);

    const islands = computeIslands(nodes, clusters);

    expect(islands).toHaveLength(8);
    for (const left of islands) {
      for (const right of islands) {
        if (left === right) continue;
        const distance = left.center.distanceTo(right.center);
        expect(distance).toBeGreaterThanOrEqual((left.radiusBlocks + right.radiusBlocks) * BLOCK);
      }
    }
  });

  it("gives every node a plot inside its island", () => {
    const nodes = Array.from({ length: 40 }, (_, index) =>
      node(index, { clusterIndex: index % 3, folder: `folder-${index % 3}` }),
    );
    const clusters = ["folder-0", "folder-1", "folder-2"];

    const islands = computeIslands(nodes, clusters);
    const plots = computePlots(nodes, islands);

    expect(plots.size).toBe(nodes.length);
    for (const plot of plots.values()) {
      const horizontal = Math.hypot(
        plot.position.x - plot.island.center.x,
        plot.position.z - plot.island.center.z,
      );
      expect(horizontal).toBeLessThanOrEqual(plot.island.radiusBlocks * BLOCK);
      expect(plot.position.y).toBe(plot.island.elevation * BLOCK);
    }
  });

  it("is deterministic for the same node set", () => {
    const nodes = Array.from({ length: 30 }, (_, index) =>
      node(index, { clusterIndex: index % 4, folder: `folder-${index % 4}` }),
    );
    const clusters = ["folder-0", "folder-1", "folder-2", "folder-3"];

    const first = computePlots(nodes, computeIslands(nodes, clusters));
    const second = computePlots(nodes, computeIslands(nodes, clusters));

    for (const [filePath, plot] of first) {
      const other = second.get(filePath);
      expect(other).toBeDefined();
      expect(other?.position.equals(plot.position)).toBe(true);
      expect(other?.rotationY).toBe(plot.rotationY);
    }
  });

  it("scales building tier with document weight and hub links", () => {
    expect(plotTierForNode(node(1, { documentLength: 100 }))).toBe(0);
    expect(plotTierForNode(node(2, { documentLength: 1_000 }))).toBe(1);
    expect(plotTierForNode(node(3, { documentLength: 3_000 }))).toBe(2);
    expect(plotTierForNode(node(4, { documentLength: 10_000 }))).toBe(3);
    expect(plotTierForNode(node(5, { documentLength: 100, linkCount: 9 }))).toBe(1);
  });

  it("reports the full graph as visible", () => {
    const nodes = Array.from({ length: 160 }, (_, index) => node(index));
    const links = Array.from({ length: 150 }, (_, index) => ({
      source: nodes[index].filePath,
      target: nodes[index + 1].filePath,
    }));
    const state = graphState(nodes, links);

    const stats = getVoxelVisibleStats(state);

    expect(stats.nodes).toBe(160);
    expect(stats.totalNodes).toBe(160);
    expect(stats.links).toBe(150);
    expect(stats.totalLinks).toBe(150);
    expect(stats.omittedNodes).toBe(0);
    expect(stats.omittedLinks).toBe(0);
    expect(stats.capped).toBe(false);
  });

  it("keeps restore keys stable for identical graph content only", () => {
    const nodes = [
      node(1, { clusterIndex: 0, folder: "team-a", documentLength: 1_200, isOrphan: false }),
      node(2, { clusterIndex: 1, folder: "team-b", documentLength: 2_400, isOrphan: false }),
    ];
    const links = [{ source: nodes[0].filePath, target: nodes[1].filePath }];
    const state = graphState(nodes, links);
    const key = agentWorldRestoreKey(state);

    expect(
      agentWorldRestoreKey({
        ...state,
        nodes: [nodes[1], nodes[0]],
        links: [links[0]],
      }),
    ).toBe(key);

    expect(
      agentWorldRestoreKey({
        ...state,
        links: [],
      }),
    ).not.toBe(key);

    expect(
      agentWorldRestoreKey({
        ...state,
        nodes: state.nodes.map((item) =>
          item.filePath === nodes[1].filePath
            ? { ...item, folder: "team-c", clusterIndex: 2 }
            : item,
        ),
        clusters: ["team-a", "team-b", "team-c"],
      }),
    ).not.toBe(key);

    expect(
      agentWorldRestoreKey({
        ...state,
        nodes: state.nodes.map((item) =>
          item.filePath === nodes[0].filePath ? { ...item, documentLength: 8_000 } : item,
        ),
      }),
    ).not.toBe(key);
  });
});
