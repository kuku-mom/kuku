import { describe, expect, it } from "vitest";

import type { GraphNode, GraphState } from "~/plugins/builtin/graph_view/graph_types";

import {
  createRoomsForNodes,
  getVoxelVisibleStats,
  roomForNode,
  selectVisibleNodes,
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
  it("keeps every note visible in large graphs", () => {
    const current = node(500, {
      filePath: "focus/current.md",
      folder: "focus",
      clusterIndex: 500,
      linkCount: 2,
      isOrphan: false,
    });
    const neighbor = node(501, {
      filePath: "focus/neighbor.md",
      folder: "focus",
      clusterIndex: 500,
      linkCount: 1,
      isOrphan: false,
    });
    const nodes = [...Array.from({ length: 200 }, (_, index) => node(index)), current, neighbor];
    const state = graphState(nodes, [{ source: current.filePath, target: neighbor.filePath }]);

    const visible = selectVisibleNodes(state, current.filePath, true);

    expect(visible).toHaveLength(nodes.length);
    expect(visible.some((item) => item.filePath === current.filePath)).toBe(true);
    expect(visible.some((item) => item.filePath === neighbor.filePath)).toBe(true);
  });

  it("creates rooms only for visible clusters and preserves original cluster indexes", () => {
    const visible = [
      node(17, { folder: "제품/기획", clusterIndex: 17 }),
      node(999, { folder: "연구/AI", clusterIndex: 999 }),
    ];
    const clusters = Array.from({ length: 1_000 }, (_, index) => `folder-${index}`);
    clusters[17] = "제품/기획";
    clusters[999] = "연구/AI";

    const rooms = createRoomsForNodes(visible, clusters, true);

    expect(rooms.map((room) => room.clusterIndex)).toEqual([17, 999]);
    expect(roomForNode(visible[1], rooms).clusterIndex).toBe(999);
    expect(roomForNode(visible[1], rooms).name).toBe("연구/AI");
  });

  it("keeps an empty root room for loading and empty states", () => {
    const rooms = createRoomsForNodes([], [], false);

    expect(rooms).toHaveLength(1);
    expect(rooms[0].clusterIndex).toBe(0);
    expect(rooms[0].name).toBe("Root");
  });

  it("reports the full graph as visible without compact capping", () => {
    const nodes = Array.from({ length: 160 }, (_, index) => node(index));
    const links = Array.from({ length: 150 }, (_, index) => ({
      source: nodes[index].filePath,
      target: nodes[index + 1].filePath,
    }));
    const state = graphState(nodes, links);

    const stats = getVoxelVisibleStats(state, null, true);

    expect(stats.nodes).toBe(160);
    expect(stats.totalNodes).toBe(160);
    expect(stats.links).toBe(150);
    expect(stats.totalLinks).toBe(150);
    expect(stats.omittedNodes).toBe(0);
    expect(stats.omittedLinks).toBe(0);
    expect(stats.capped).toBe(false);
  });
});
