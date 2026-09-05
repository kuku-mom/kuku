import { describe, expect, it } from "vitest";
import {
  constellationCenters,
  constellationColor,
  constellationLabelCandidates,
  seedConstellation,
} from "./graph_constellation";
import type { FGNode } from "./graph_types";
const node = (i: number, clusterIndex = i % 5): FGNode => ({
  id: `note-${i}`,
  filePath: `note-${i}`,
  name: `Note ${i}`,
  folder: `folder-${clusterIndex}`,
  clusterIndex,
  linkCount: i % 9,
  isOrphan: false,
});
describe("constellation layout", () => {
  it("seeds reproducible finite 3D positions and preserves existing simulation positions", () => {
    const centers = constellationCenters(5, 200);
    const nodes = Array.from({ length: 220 }, (_, i) => node(i));
    const copy = nodes.map((n) => ({ ...n }));
    seedConstellation(nodes, centers, 200);
    seedConstellation(copy, centers, 200);
    expect(nodes).toEqual(copy);
    expect(nodes.every((n) => [n.x, n.y, n.z].every(Number.isFinite))).toBe(true);
    expect(new Set(nodes.map((n) => n.z)).size).toBeGreaterThan(100);
    nodes[0].x = 999;
    seedConstellation(nodes, constellationCenters(5, 400), 400);
    expect(nodes[0].x).toBe(999);
  });
  it("supports empty and single-folder graphs", () => {
    expect(constellationCenters(0, 200).size).toBe(0);
    expect(constellationCenters(1, 200).get(0)).toEqual({ x: -0, y: 0, z: 0 });
    const orphan = { ...node(0), isOrphan: true };
    seedConstellation([orphan], new Map(), 200);
    expect(Math.hypot(orphan.x ?? 0, orphan.y ?? 0, orphan.z ?? 0)).toBeCloseTo(270);
  });
});
describe("constellation labels", () => {
  const nodes = Array.from({ length: 1500 }, (_, i) => node(i));
  it("keeps one hub per folder at overview and caps detail labels", () => {
    const overview = constellationLabelCandidates(nodes, [], 12, false);
    expect(overview).toHaveLength(5);
    expect(
      new Set(overview.map((path) => nodes.find((n) => n.filePath === path)?.clusterIndex)).size,
    ).toBe(5);
    expect(constellationLabelCandidates(nodes, [], 12, true)).toHaveLength(12);
  });
  it("prioritizes focused documents without retaining stale or duplicate paths", () => {
    const labels = constellationLabelCandidates(
      nodes,
      ["note-0", "missing", "note-0", "note-1"],
      4,
      true,
    );
    expect(labels.slice(0, 2)).toEqual(["note-0", "note-1"]);
    expect(labels).toHaveLength(4);
    expect(labels).not.toContain("missing");
    expect(constellationLabelCandidates([], ["note-0"], 4, false)).toEqual([]);
  });
  it("keeps folder identity consistent while adapting pigment to the theme", () => {
    expect(constellationColor(0, "light")).not.toBe(constellationColor(0, "dark"));
    expect(constellationColor(0, "light")).toContain("258");
    expect(constellationColor(0, "dark")).toContain("258");
    expect(constellationColor(10, "dark")).toBe(constellationColor(0, "dark"));
  });
});
