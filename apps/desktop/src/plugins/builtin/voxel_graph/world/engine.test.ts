// @vitest-environment jsdom
//
// Smoke tests for the agent world engine: builds a real world from a small
// graph and ticks the simulation. Catches construction/update regressions
// without a WebGL context (three.js scene graph works headless).

import { Matrix4, Vector3, type InstancedMesh, type Object3D } from "three";
import { describe, expect, it, vi } from "vitest";

import type { GraphLink, GraphNode } from "~/plugins/builtin/graph_view/graph_types";

import { classForNode } from "./agents";
import { createAgentWorld } from "./engine";

// three-spritetext needs a 2D canvas context, which jsdom does not provide.
// vi.mock is hoisted above the imports, so the engine sees the fake.
vi.mock("three-spritetext", () => {
  class FakeSpriteText {
    text = "";
    textHeight = 0;
    color = "";
    backgroundColor: string | boolean = false;
    padding = 0;
    borderRadius = 0;
    material = { depthWrite: true, map: { dispose: vi.fn() }, dispose: vi.fn() };
    position = { set: vi.fn() };
    constructor(text?: string) {
      this.text = text ?? "";
    }
  }
  return { default: FakeSpriteText };
});

function node(index: number, cluster: number, links = 0): GraphNode {
  return {
    id: `folder-${cluster}/note-${index}.md`,
    name: `Note ${index}`,
    filePath: `folder-${cluster}/note-${index}.md`,
    folder: `folder-${cluster}`,
    clusterIndex: cluster,
    linkCount: links,
    isOrphan: links === 0,
    documentLength: 300 + index * 900,
  };
}

function makeWorldInput() {
  const nodes = [node(0, 0, 1), node(1, 0, 1), node(2, 1, 2), node(3, 1, 0), node(4, 2, 1)];
  const links: GraphLink[] = [
    { source: nodes[0].filePath, target: nodes[1].filePath },
    { source: nodes[1].filePath, target: nodes[2].filePath },
    { source: nodes[2].filePath, target: nodes[4].filePath },
  ];
  const adjacencyMap: Record<string, string[]> = {};
  for (const item of nodes) adjacencyMap[item.filePath] = [];
  for (const link of links) {
    adjacencyMap[link.source].push(link.target);
    adjacencyMap[link.target].push(link.source);
  }
  return {
    nodes,
    links,
    adjacencyMap,
    clusters: ["folder-0", "folder-1", "folder-2"],
  };
}

function visibleInstanceCount(mesh: InstancedMesh): number {
  const matrix = new Matrix4();
  const scale = new Vector3();
  let visible = 0;
  for (let index = 0; index < mesh.count; index++) {
    mesh.getMatrixAt(index, matrix);
    scale.setFromMatrixScale(matrix);
    if (scale.x > 0.001 || scale.y > 0.001 || scale.z > 0.001) visible += 1;
  }
  return visible;
}

function findInstancedMesh(root: Object3D, predicate: (mesh: InstancedMesh) => boolean) {
  let found: InstancedMesh | null = null;
  root.traverse((object) => {
    if (found) return;
    const mesh = object as InstancedMesh;
    if (mesh.isInstancedMesh && predicate(mesh)) found = mesh;
  });
  if (!found) throw new Error("expected instanced mesh");
  return found;
}

describe("agent classes", () => {
  it("assigns RPG classes from note stats", () => {
    expect(classForNode({ ...node(0, 0), linkCount: 12 })).toBe("noble");
    expect(classForNode({ ...node(0, 0), linkCount: 7 })).toBe("knight");
    expect(classForNode({ ...node(0, 0), documentLength: 6_000 })).toBe("wizard");
    expect(classForNode({ ...node(0, 0), linkCount: 4 })).toBe("ranger");
    expect(classForNode({ ...node(0, 0), linkCount: 0, isOrphan: true })).toBe("peasant");
  });
});

describe("agent world engine", () => {
  it("builds a world for both moods and survives simulation ticks", () => {
    for (const mood of ["day", "night"] as const) {
      const engine = createAgentWorld({ ...makeWorldInput(), mood, compact: false });

      expect(engine.worldRadius).toBeGreaterThan(0);
      expect(engine.islands).toHaveLength(3);
      expect(engine.group.children.length).toBeGreaterThan(0);

      // Run a few seconds of simulation, long enough for agents to decide
      // and start walking.
      for (let frame = 0; frame < 240; frame++) {
        engine.update(frame / 60, 1 / 60);
      }

      engine.dispose();
    }
  });

  it("keeps agents out of house footprints while they roam", async () => {
    const { computeIslands, computePlots, BLOCK } = await import("../voxel_layout");
    const input = makeWorldInput();
    const engine = createAgentWorld({ ...input, mood: "day", compact: false });
    const plots = computePlots(input.nodes, computeIslands(input.nodes, input.clusters));

    for (let frame = 0; frame < 900; frame++) {
      engine.update(frame / 60, 1 / 60);
      if (frame % 60 !== 0) continue;
      for (const item of input.nodes) {
        const anchor = engine.anchorFor(item.filePath);
        if (!anchor) continue;
        for (const plot of plots.values()) {
          // Only enforce on land at that island's surface (bridges exempt).
          const surfaceY = plot.island.elevation * BLOCK + BLOCK;
          if (Math.abs(anchor.y - surfaceY) > 2) continue;
          const distance = Math.hypot(anchor.x - plot.position.x, anchor.z - plot.position.z);
          expect(distance).toBeGreaterThan(6.2);
        }
      }
    }
    engine.dispose();
  });

  it("keeps agent positions across rebuilds (theme switches)", () => {
    const input = makeWorldInput();
    const first = createAgentWorld({ ...input, mood: "day", compact: false });
    // Let agents move away from their spawn points.
    for (let frame = 0; frame < 600; frame++) {
      first.update(frame / 60, 1 / 60);
    }
    const snapshot = first.agentSnapshot();
    const movedPositions = new Map(
      input.nodes.map((item) => [item.filePath, first.anchorFor(item.filePath)]),
    );
    first.dispose();

    const second = createAgentWorld({
      ...input,
      mood: "night",
      compact: false,
      restoreAgents: snapshot,
    });
    for (const item of input.nodes) {
      const before = movedPositions.get(item.filePath);
      const after = second.anchorFor(item.filePath);
      expect(before).not.toBeNull();
      expect(after).not.toBeNull();
      expect(after?.distanceTo(before ?? after) ?? 1).toBeLessThan(0.001);
    }
    second.dispose();
  });

  it("tracks focus, hover, and selection without errors", () => {
    const input = makeWorldInput();
    const engine = createAgentWorld({ ...input, mood: "night", compact: true });
    const filePath = input.nodes[0].filePath;

    engine.setFocus(filePath);
    engine.setHovered(input.nodes[1].filePath);
    engine.setSelected(input.nodes[2].filePath);
    engine.update(0.5, 1 / 60);

    expect(engine.anchorFor(filePath)).not.toBeNull();

    engine.setFocus(null);
    engine.setHovered(null);
    engine.setSelected(null);
    engine.update(1, 1 / 60);
    engine.dispose();
  });

  it("clears focus marker and trails when focus is outside the graph", () => {
    const input = makeWorldInput();
    const engine = createAgentWorld({ ...input, mood: "day", compact: false });
    const marker = findInstancedMesh(engine.group, (mesh) => mesh.count === 11);
    const trails = findInstancedMesh(engine.group, (mesh) => mesh.count === 900);

    engine.setFocus(input.nodes[1].filePath);
    expect(visibleInstanceCount(marker)).toBeGreaterThan(0);
    expect(visibleInstanceCount(trails)).toBeGreaterThan(0);

    engine.setFocus("outside-graph.md");

    expect(visibleInstanceCount(marker)).toBe(0);
    expect(visibleInstanceCount(trails)).toBe(0);
    engine.dispose();
  });
});
