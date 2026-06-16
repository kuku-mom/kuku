// @vitest-environment jsdom
//
// Smoke tests for the agent world engine: builds a real world from a small
// graph and ticks the simulation. Catches construction/update regressions
// without a WebGL context (three.js scene graph works headless).

import {
  Matrix4,
  Raycaster,
  Vector3,
  type InstancedMesh,
  type MeshBasicMaterial,
  type Object3D,
} from "three";
import { describe, expect, it, vi } from "vitest";

import type { GraphLink, GraphNode } from "~/plugins/builtin/graph_view/graph_types";

import { classForNode, type AgentSnapshot } from "./agents";
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

function agentSnapshot(overrides: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return {
    position: new Vector3(12, 0, 8),
    heading: 0,
    targetHeading: 0,
    state: "walk",
    waypoints: [new Vector3(20, 0, 8)],
    waypointIndex: 0,
    restTimer: 0,
    walkPhase: 0,
    awayFromHome: true,
    workKind: null,
    workTimer: 0,
    pendingWork: null,
    pendingInside: false,
    ...overrides,
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

function findInstancedMesh(
  root: Object3D,
  predicate: (mesh: InstancedMesh) => boolean,
): InstancedMesh {
  let found: InstancedMesh | null = null;
  root.traverse((object) => {
    if (found) return;
    const mesh = object as InstancedMesh;
    if (mesh.isInstancedMesh && predicate(mesh)) found = mesh;
  });
  const result = found;
  if (!result) throw new Error("expected instanced mesh");
  return result;
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
    const indicators = findInstancedMesh(
      engine.group,
      (mesh) => mesh.name === "voxel-interaction-indicators",
    );

    expect(visibleInstanceCount(indicators)).toBe(0);

    engine.setFocus(filePath);
    engine.setHovered(input.nodes[1].filePath);
    engine.setSelected(input.nodes[2].filePath);
    engine.update(0.5, 1 / 60);

    expect(engine.anchorFor(filePath)).not.toBeNull();
    expect(visibleInstanceCount(indicators)).toBe(3);

    engine.setFocus(null);
    engine.setHovered(null);
    engine.setSelected(null);
    engine.update(1, 1 / 60);

    expect(visibleInstanceCount(indicators)).toBe(0);
    engine.dispose();
  });

  it("falls back to house anchors when animated agents are disabled", () => {
    const input = makeWorldInput();
    const engine = createAgentWorld({
      ...input,
      mood: "day",
      compact: false,
      renderSettings: {
        maxAgents: 0,
        agentSpeed: "medium",
        natureDensity: "medium",
      },
    });
    const filePath = input.nodes[0].filePath;

    expect(engine.anchorFor(filePath)).not.toBeNull();
    engine.setFocus(filePath, true);
    engine.update(0.5, 1 / 60);

    engine.dispose();
  });

  it("anchors the camera to visible agents and inside agents to homes", () => {
    const input = makeWorldInput();
    const filePath = input.nodes[0].filePath;
    const visiblePosition = new Vector3(12, 0, 8);
    const visibleEngine = createAgentWorld({
      ...input,
      mood: "day",
      compact: false,
      restoreAgents: new Map([
        [
          filePath,
          agentSnapshot({
            position: visiblePosition.clone(),
            state: "pause",
            waypoints: [],
          }),
        ],
      ]),
    });

    expect(visibleEngine.anchorFor(filePath)?.distanceTo(new Vector3(12, 4, 8))).toBeLessThan(
      0.001,
    );
    const followIndicators = findInstancedMesh(
      visibleEngine.group,
      (mesh) => mesh.name === "voxel-interaction-indicators",
    );
    visibleEngine.setFocus(filePath, true);
    visibleEngine.update(0.2, 1 / 60);
    const followIndicatorMatrix = new Matrix4();
    const followIndicatorPosition = new Vector3();
    followIndicators.getMatrixAt(0, followIndicatorMatrix);
    followIndicatorPosition.setFromMatrixPosition(followIndicatorMatrix);
    expect(followIndicatorPosition.x).toBeCloseTo(visiblePosition.x);
    expect(followIndicatorPosition.z).toBeCloseTo(visiblePosition.z);
    visibleEngine.dispose();

    const insideEngine = createAgentWorld({
      ...input,
      mood: "day",
      compact: false,
      restoreAgents: new Map([
        [
          filePath,
          agentSnapshot({
            position: visiblePosition.clone(),
            state: "inside",
            waypoints: [],
          }),
        ],
      ]),
    });
    const insideAnchor = insideEngine.anchorFor(filePath);

    expect(insideAnchor).not.toBeNull();
    expect(insideAnchor?.y).toBeGreaterThan(10);
    insideEngine.dispose();
  });

  it("keeps a visible indicator for picked characters", () => {
    const input = makeWorldInput();
    const engine = createAgentWorld({ ...input, mood: "day", compact: false });
    const groundIndicators = findInstancedMesh(
      engine.group,
      (mesh) => mesh.name === "voxel-interaction-indicators",
    );
    const groundIndicatorMaterial = groundIndicators.material as MeshBasicMaterial;

    expect(groundIndicators.renderOrder).toBeGreaterThan(0);
    expect(groundIndicatorMaterial.depthTest).toBe(true);
    expect(groundIndicatorMaterial.depthWrite).toBe(false);

    engine.update(0, 1 / 60);

    let picked: GraphNode | null = null;
    for (const saved of engine.agentSnapshot().values()) {
      if (saved.state === "inside") continue;
      const raycaster = new Raycaster(
        new Vector3(saved.position.x, saved.position.y + 60, saved.position.z),
        new Vector3(0, -1, 0),
      );
      picked = engine.pick(raycaster);
      if (picked) break;
    }

    expect(picked).not.toBeNull();
    engine.setHovered(picked?.filePath ?? null);
    engine.update(0.2, 1 / 60);

    expect(visibleInstanceCount(groundIndicators)).toBe(1);
    const indicatorMatrix = new Matrix4();
    const indicatorPosition = new Vector3();
    groundIndicators.getMatrixAt(0, indicatorMatrix);
    indicatorPosition.setFromMatrixPosition(indicatorMatrix);
    expect(indicatorPosition.y).toBeGreaterThan(0.65);

    engine.setHovered(null);
    engine.update(0.3, 1 / 60);

    expect(visibleInstanceCount(groundIndicators)).toBe(0);
    engine.dispose();
  });

  it("clears focus marker and trails when focus is outside the graph", () => {
    const input = makeWorldInput();
    const engine = createAgentWorld({ ...input, mood: "day", compact: false });
    const marker = findInstancedMesh(engine.group, (mesh) => mesh.count === 11);
    const trails = findInstancedMesh(engine.group, (mesh) => mesh.count === 900);
    const indicators = findInstancedMesh(
      engine.group,
      (mesh) => mesh.name === "voxel-interaction-indicators",
    );

    engine.setFocus(input.nodes[1].filePath);
    expect(visibleInstanceCount(marker)).toBeGreaterThan(0);
    expect(visibleInstanceCount(trails)).toBeGreaterThan(0);
    expect(visibleInstanceCount(indicators)).toBe(1);

    engine.setFocus("outside-graph.md");

    expect(visibleInstanceCount(marker)).toBe(0);
    expect(visibleInstanceCount(trails)).toBe(0);
    expect(visibleInstanceCount(indicators)).toBe(0);
    engine.dispose();
  });
});
