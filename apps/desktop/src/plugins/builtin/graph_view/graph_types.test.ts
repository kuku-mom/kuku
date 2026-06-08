import { describe, expect, it } from "vitest";

import {
  GRAPH_3D_SCROLL_ZOOM_SPEED,
  GRAPH_SETTINGS_DEFAULTS,
  filterGraphState,
  hasGraphPointerTarget,
  mergeGraphViewSettings,
  type GraphState,
} from "./graph_types";

function graphState(): GraphState {
  return {
    nodes: [
      {
        id: "Knowledge/wiki/concepts/auth.md",
        name: "Auth",
        filePath: "Knowledge/wiki/concepts/auth.md",
        folder: "Knowledge/wiki/concepts",
        clusterIndex: 0,
        linkCount: 2,
        isOrphan: false,
      },
      {
        id: "Knowledge/memory/session.md",
        name: "Session",
        filePath: "Knowledge/memory/session.md",
        folder: "Knowledge/memory",
        clusterIndex: 1,
        linkCount: 1,
        isOrphan: false,
      },
      {
        id: "Projects/auth.md",
        name: "Project Auth",
        filePath: "Projects/auth.md",
        folder: "Projects",
        clusterIndex: 2,
        linkCount: 1,
        isOrphan: false,
      },
    ],
    links: [
      { source: "Knowledge/wiki/concepts/auth.md", target: "Knowledge/memory/session.md" },
      { source: "Knowledge/wiki/concepts/auth.md", target: "Projects/auth.md" },
    ],
    adjacencyMap: {
      "Knowledge/wiki/concepts/auth.md": ["Knowledge/memory/session.md", "Projects/auth.md"],
      "Knowledge/memory/session.md": ["Knowledge/wiki/concepts/auth.md"],
      "Projects/auth.md": ["Knowledge/wiki/concepts/auth.md"],
    },
    clusters: ["Knowledge/wiki/concepts", "Knowledge/memory", "Projects"],
    isIndexing: false,
    lastIndexedAt: 1,
    error: null,
  };
}

describe("filterGraphState", () => {
  it("keeps only matching nodes and recalculates the visible subgraph", () => {
    const filtered = filterGraphState(graphState(), (node) =>
      node.filePath.toLowerCase().startsWith("knowledge/"),
    );

    expect(filtered.nodes.map((node) => node.filePath)).toEqual([
      "Knowledge/wiki/concepts/auth.md",
      "Knowledge/memory/session.md",
    ]);
    expect(filtered.links).toEqual([
      { source: "Knowledge/wiki/concepts/auth.md", target: "Knowledge/memory/session.md" },
    ]);
    expect(filtered.adjacencyMap).toEqual({
      "Knowledge/wiki/concepts/auth.md": ["Knowledge/memory/session.md"],
      "Knowledge/memory/session.md": ["Knowledge/wiki/concepts/auth.md"],
    });
    expect(filtered.nodes.map((node) => [node.filePath, node.linkCount, node.isOrphan])).toEqual([
      ["Knowledge/wiki/concepts/auth.md", 1, false],
      ["Knowledge/memory/session.md", 1, false],
    ]);
    expect(filtered.clusters).toEqual(["Knowledge/memory", "Knowledge/wiki/concepts"]);
  });

  it("can preserve original cluster indexes so filtered nodes keep their colors", () => {
    const filtered = filterGraphState(
      graphState(),
      (node) => node.folder === "Projects",
      { preserveClusterIndices: true },
    );

    expect(filtered.nodes).toHaveLength(1);
    expect(filtered.nodes[0].folder).toBe("Projects");
    expect(filtered.nodes[0].clusterIndex).toBe(2);
    expect(filtered.clusters).toEqual([
      "Knowledge/wiki/concepts",
      "Knowledge/memory",
      "Projects",
    ]);
  });
});

describe("mergeGraphViewSettings", () => {
  it("migrates legacy graph settings into both renderer scopes", () => {
    const merged = mergeGraphViewSettings({
      chargeStrength: -310,
      linkOpacity: 1.35,
      showClusters: false,
    });

    expect(merged.twoD.chargeStrength).toBe(-310);
    expect(merged.threeD.chargeStrength).toBe(-310);
    expect(merged.twoD.linkOpacity).toBe(1.35);
    expect(merged.threeD.linkOpacity).toBe(1.35);
    expect(merged.twoD.showClusters).toBe(false);
    expect(merged.threeD.showClusters).toBe(false);
  });

  it("keeps 2D and 3D settings independent when scoped settings already exist", () => {
    const merged = mergeGraphViewSettings({
      twoD: {
        chargeStrength: -180,
        linkDistance: 96,
      },
      threeD: {
        chargeStrength: -420,
        nodeSize: 1.6,
      },
    });

    expect(merged.twoD.chargeStrength).toBe(-180);
    expect(merged.threeD.chargeStrength).toBe(-420);
    expect(merged.twoD.linkDistance).toBe(96);
    expect(merged.threeD.linkDistance).toBe(GRAPH_SETTINGS_DEFAULTS.linkDistance);
    expect(merged.twoD.nodeSize).toBe(GRAPH_SETTINGS_DEFAULTS.nodeSize);
    expect(merged.threeD.nodeSize).toBe(1.6);
  });

  it("adds screenshot-level graph controls to migrated settings", () => {
    const merged = mergeGraphViewSettings({});

    expect(merged.twoD.showArrows).toBe(GRAPH_SETTINGS_DEFAULTS.showArrows);
    expect(merged.twoD.labelVisibilityThreshold).toBe(
      GRAPH_SETTINGS_DEFAULTS.labelVisibilityThreshold,
    );
    expect(merged.twoD.nodeSize).toBe(GRAPH_SETTINGS_DEFAULTS.nodeSize);
    expect(merged.twoD.linkStrength).toBe(GRAPH_SETTINGS_DEFAULTS.linkStrength);
    expect(merged.twoD.linkDistance).toBe(GRAPH_SETTINGS_DEFAULTS.linkDistance);
  });
});

describe("hasGraphPointerTarget", () => {
  it("treats only nullish empty-canvas targets as non-clickable", () => {
    expect(hasGraphPointerTarget(null)).toBe(false);
    expect(hasGraphPointerTarget(undefined)).toBe(false);
    expect(hasGraphPointerTarget({ id: "Knowledge/auth.md" })).toBe(true);
  });
});

describe("GRAPH_3D_SCROLL_ZOOM_SPEED", () => {
  it("keeps 3D wheel zoom in the same direction as the 2D graph", () => {
    expect(GRAPH_3D_SCROLL_ZOOM_SPEED).toBeGreaterThan(0);
  });
});
