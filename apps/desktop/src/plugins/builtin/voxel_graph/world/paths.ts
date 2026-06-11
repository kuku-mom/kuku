// ── Agent World Paths ──
//
// Infrastructure between notes: stone walkways from every house to its island
// plaza, and wooden bridges between islands that link to each other. When a
// note is focused, its wikilinks appear as glowing trails laid on the ground
// (and across the water surface) toward each linked house — nothing flies.

import { Group, Vector3, type MeshBasicMaterial } from "three";

import { BLOCK, PLAZA_RADIUS, type IslandSpec, type PlotSpec } from "../voxel_layout";
import type { GraphLink } from "~/plugins/builtin/graph_view/graph_types";

import { glowBatch, solidBatch, type BoxWrite, type VoxelBatch } from "./batch";
import type { WorldPalette } from "./palette";
import { WATER_LEVEL } from "./terrain";

export interface BridgeInfo {
  clusterA: number;
  clusterB: number;
  /** Walkable deck endpoints (at deck height) on each island's shore. */
  start: Vector3;
  end: Vector3;
}

export interface TrailPair {
  from: Vector3;
  to: Vector3;
}

export interface PathsHandle {
  group: Group;
  bridges: ReadonlyMap<string, BridgeInfo>;
  /** Lays glowing ground trails from the focused house to its links. */
  setFocusTrails(pairs: readonly TrailPair[]): void;
  update(nowSeconds: number): void;
  dispose(): void;
}

export function bridgeKey(clusterA: number, clusterB: number): string {
  return clusterA < clusterB ? `${clusterA}:${clusterB}` : `${clusterB}:${clusterA}`;
}

const MAX_BRIDGES = 24;
const DECK_Y = WATER_LEVEL + 1.7;
const BEACH_WIDTH = 2.1;
const TRAIL_CAPACITY = 900;
const TRAIL_TILES_PER_LINK = 80;

interface PathsOptions {
  islands: readonly IslandSpec[];
  plots: ReadonlyMap<string, PlotSpec>;
  links: readonly GraphLink[];
  doorPosition(filePath: string): Vector3 | null;
  palette: WorldPalette;
}

function pushWalkway(
  writes: BoxWrite[],
  plot: PlotSpec,
  door: Vector3,
  palette: WorldPalette,
): void {
  const island = plot.island;
  const target = new Vector3(island.center.x, door.y, island.center.z);
  const direction = target.clone().sub(door);
  direction.y = 0;
  const total = direction.length();
  const stopBefore = (PLAZA_RADIUS + 0.6) * BLOCK;
  const span = total - stopBefore;
  if (span <= 0 || total === 0) return;

  direction.normalize();
  const rotY = Math.atan2(direction.x, direction.z);
  const steps = Math.min(40, Math.floor(span / (BLOCK * 0.8)));
  for (let step = 0; step <= steps; step++) {
    const at = door.clone().addScaledVector(direction, (step / Math.max(1, steps)) * span);
    // Alternate tile heights so overlapping neighbours never share a
    // coplanar top face (which shimmered at grazing angles).
    writes.push({
      x: at.x,
      y: at.y + (step % 2 === 0 ? 0.24 : 0.34),
      z: at.z,
      sx: 2.3,
      sy: 0.5,
      sz: 2.6,
      rotY,
      color: palette.path,
    });
  }
}

function computeBridges(
  islands: readonly IslandSpec[],
  links: readonly GraphLink[],
  plots: ReadonlyMap<string, PlotSpec>,
): Map<string, BridgeInfo> {
  const linkCounts = new Map<string, number>();
  for (const link of links) {
    const source = plots.get(link.source);
    const target = plots.get(link.target);
    if (!source || !target) continue;
    const a = source.island.clusterIndex;
    const b = target.island.clusterIndex;
    if (a === b) continue;
    const key = bridgeKey(a, b);
    linkCounts.set(key, (linkCounts.get(key) ?? 0) + 1);
  }

  const byCluster = new Map<number, IslandSpec>();
  for (const island of islands) byCluster.set(island.clusterIndex, island);

  const bridges = new Map<string, BridgeInfo>();
  const ranked = [...linkCounts.entries()].sort(
    (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
  );

  for (const [key] of ranked.slice(0, MAX_BRIDGES)) {
    const [aIndex, bIndex] = key.split(":").map(Number);
    const islandA = byCluster.get(aIndex);
    const islandB = byCluster.get(bIndex);
    if (!islandA || !islandB) continue;

    const direction = islandB.center.clone().sub(islandA.center);
    direction.y = 0;
    direction.normalize();
    const start = islandA.center
      .clone()
      .addScaledVector(direction, (islandA.radiusBlocks - 0.6) * BLOCK);
    const end = islandB.center
      .clone()
      .addScaledVector(direction.clone().negate(), (islandB.radiusBlocks - 0.6) * BLOCK);
    start.y = DECK_Y;
    end.y = DECK_Y;
    bridges.set(key, { clusterA: aIndex, clusterB: bIndex, start, end });
  }

  return bridges;
}

function pushBridgeGeometry(
  writes: BoxWrite[],
  bridge: BridgeInfo,
  byCluster: ReadonlyMap<number, IslandSpec>,
  palette: WorldPalette,
): void {
  const direction = bridge.end.clone().sub(bridge.start);
  direction.y = 0;
  const length = direction.length();
  if (length === 0) return;
  direction.normalize();
  const rotY = Math.atan2(direction.x, direction.z);

  // Deck planks with side rails.
  const plankCount = Math.max(2, Math.floor(length / (BLOCK * 0.72)));
  for (let plank = 0; plank <= plankCount; plank++) {
    const at = bridge.start.clone().addScaledVector(direction, (plank / plankCount) * length);
    writes.push({
      x: at.x,
      y: DECK_Y,
      z: at.z,
      sx: 4.6,
      sy: 0.7,
      sz: 2.4,
      rotY,
      color: palette.bridge,
    });
    // Support posts into the water and railing posts every few planks.
    if (plank % 5 === 2) {
      for (const side of [-1, 1]) {
        const post = at
          .clone()
          .addScaledVector(new Vector3(direction.z, 0, -direction.x), side * 2.1);
        writes.push({
          x: post.x,
          y: WATER_LEVEL - BLOCK,
          z: post.z,
          sx: 0.9,
          sy: BLOCK * 2.6,
          sz: 0.9,
          rotY,
          color: palette.bridgePost,
        });
        writes.push({
          x: post.x,
          y: DECK_Y + 1.4,
          z: post.z,
          sx: 0.55,
          sy: 2.2,
          sz: 0.55,
          rotY,
          color: palette.bridgePost,
        });
      }
    }
  }
  // Railing beams.
  for (const side of [-1, 1]) {
    const mid = bridge.start
      .clone()
      .addScaledVector(direction, length / 2)
      .addScaledVector(new Vector3(direction.z, 0, -direction.x), side * 2.1);
    writes.push({
      x: mid.x,
      y: DECK_Y + 2.3,
      z: mid.z,
      sx: 0.45,
      sy: 0.45,
      sz: length,
      rotY,
      color: palette.bridgePost,
    });
  }

  // Steps from each shore down to the deck.
  for (const [endpoint, clusterIndex] of [
    [bridge.start, bridge.clusterA],
    [bridge.end, bridge.clusterB],
  ] as const) {
    const island = byCluster.get(clusterIndex);
    if (!island) continue;
    const beachY = (island.elevation - 1) * BLOCK;
    const inland = island.center.clone().sub(endpoint);
    inland.y = 0;
    inland.normalize();
    const stepCount = 3;
    for (let step = 0; step < stepCount; step++) {
      const t = (step + 1) / (stepCount + 1);
      const at = endpoint.clone().addScaledVector(inland, t * BLOCK * 2.2);
      writes.push({
        x: at.x,
        y: DECK_Y + (beachY - DECK_Y) * t,
        z: at.z,
        sx: 4.2,
        sy: 0.8,
        sz: 1.6,
        rotY,
        color: palette.bridge,
      });
    }
  }
}

export function createPaths(options: PathsOptions): PathsHandle {
  const { islands, plots, links, palette } = options;
  const group = new Group();
  const solidWrites: BoxWrite[] = [];

  // Walkways from every door to its plaza.
  for (const plot of plots.values()) {
    const door = options.doorPosition(plot.node.filePath);
    if (door) pushWalkway(solidWrites, plot, door, palette);
  }

  // Bridges between linked islands.
  const bridges = computeBridges(islands, links, plots);
  const byCluster = new Map<number, IslandSpec>();
  for (const island of islands) byCluster.set(island.clusterIndex, island);
  for (const bridge of bridges.values()) {
    pushBridgeGeometry(solidWrites, bridge, byCluster, palette);
  }

  const solids = solidBatch(solidWrites.length);
  for (const write of solidWrites) solids.add(write);
  solids.commit();
  group.add(solids.mesh);

  // ── Focus trails ──
  //
  // Ground height under a trail tile: island surface, the beach step near the
  // shore, or just above the water between islands.
  function groundHeightAt(x: number, z: number): number {
    for (const island of islands) {
      const dist = Math.hypot(x - island.center.x, z - island.center.z) / BLOCK;
      if (dist <= island.radiusBlocks) {
        const surface = island.elevation * BLOCK;
        return dist > island.radiusBlocks - BEACH_WIDTH ? surface - BLOCK : surface;
      }
    }
    return WATER_LEVEL;
  }

  const trails: VoxelBatch = glowBatch(TRAIL_CAPACITY, true, 0.85);
  trails.reserve(TRAIL_CAPACITY);
  trails.commit();
  group.add(trails.mesh);
  let trailCount = 0;

  function setFocusTrails(pairs: readonly TrailPair[]): void {
    let cursor = 0;
    for (const pair of pairs) {
      const flat = pair.to.clone().sub(pair.from);
      flat.y = 0;
      const distance = flat.length();
      if (distance < BLOCK) continue;
      const direction = flat.normalize();
      const rotY = Math.atan2(direction.x, direction.z);
      const tiles = Math.min(TRAIL_TILES_PER_LINK, Math.floor(distance / (BLOCK * 0.9)));
      for (let tile = 1; tile < tiles && cursor < TRAIL_CAPACITY; tile++) {
        const t = tile / tiles;
        const x = pair.from.x + direction.x * distance * t;
        const z = pair.from.z + direction.z * distance * t;
        trails.set(cursor, {
          x,
          y: groundHeightAt(x, z) + 0.45,
          z,
          sx: 1.3,
          sy: 0.35,
          sz: 2,
          rotY,
          color: palette.trail,
        });
        cursor += 1;
      }
      if (cursor >= TRAIL_CAPACITY) break;
    }
    for (let index = cursor; index < trailCount; index++) trails.hide(index);
    trailCount = cursor;
    trails.commit();
  }

  const trailMaterial = trails.mesh.material as MeshBasicMaterial;

  function update(nowSeconds: number): void {
    if (trailCount === 0) return;
    // Soft shimmer on the laid trail — brightness only, the tiles stay put.
    trailMaterial.opacity = 0.7 + Math.sin(nowSeconds * 2.6) * 0.18;
  }

  return {
    group,
    bridges,
    setFocusTrails,
    update,
    dispose: () => {
      solids.dispose();
      trails.dispose();
    },
  };
}
