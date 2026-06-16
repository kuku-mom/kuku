// ── Agent World Paths ──
//
// Infrastructure on the single flat countryside: warm dirt lanes from every
// house to its village (folder) centre, and wider dirt roads linking the
// villages across the open land. No bridges — everything is one continuous flat
// plane. When a note is focused, its wikilinks appear as glowing ground trails
// toward each linked house. Everything is cel-shaded in the Ghibli palette.

import { BoxGeometry, Group, Vector3, type BufferGeometry, type MeshBasicMaterial } from "three";

import type { GraphLink } from "~/plugins/builtin/graph_view/graph_types";

import type { WorldPalette } from "./palette";

import {
  BLOCK,
  ISLAND_ELEVATION,
  PLAZA_RADIUS,
  stableNoise,
  type IslandSpec,
  type PlotSpec,
} from "../voxel_layout";
import { glowBatch, toonBatch, type BoxWrite, type VoxelBatch } from "./batch";

/** Kept for interface compatibility; on the flat mainland there are no bridges. */
export interface BridgeInfo {
  clusterA: number;
  clusterB: number;
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

/** Everything walkable sits on this single flat height. */
const GROUND_Y = ISLAND_ELEVATION * BLOCK;
const TRAIL_CAPACITY = 900;
const TRAIL_TILES_PER_LINK = 80;

interface PathsOptions {
  islands: readonly IslandSpec[];
  plots: ReadonlyMap<string, PlotSpec>;
  links: readonly GraphLink[];
  doorPosition(filePath: string): Vector3 | null;
  palette: WorldPalette;
}

interface WalkwayDetail {
  maxTiles: number;
  gap: number;
  size: number;
}

/** A worn dirt lane from a door toward a centre point (the village plaza). */
function pushLane(
  writes: BoxWrite[],
  seedId: string,
  door: Vector3,
  centre: Vector3,
  palette: WorldPalette,
  detail: WalkwayDetail,
): void {
  const direction = centre.clone().sub(door);
  direction.y = 0;
  const total = direction.length();
  const stopBefore = (PLAZA_RADIUS + 0.6) * BLOCK;
  const span = total - stopBefore;
  if (span <= 0 || total === 0) return;

  direction.normalize();
  const heading = Math.atan2(direction.x, direction.z);
  const lateralX = direction.z;
  const lateralZ = -direction.x;
  const bend = (stableNoise(`lane:${seedId}:bend`) - 0.5) * 3.2;
  const steps = Math.min(detail.maxTiles, Math.max(3, Math.floor(span / (BLOCK * detail.gap))));
  for (let step = 0; step <= steps; step++) {
    const t = step / steps;
    const seed = `lane:${seedId}:${step}`;
    const at = door.clone().addScaledVector(direction, t * span);
    const drift = Math.sin(t * Math.PI) * bend;
    writes.push({
      x: at.x + lateralX * drift,
      y: GROUND_Y + (step % 2 === 0 ? 0.2 : 0.28),
      z: at.z + lateralZ * drift,
      sx: detail.size + stableNoise(`${seed}:w`) * 0.7,
      sy: 0.4,
      sz: detail.size * 1.03 + stableNoise(`${seed}:l`) * 0.7,
      rotY: heading + (stableNoise(`${seed}:r`) - 0.5) * 0.25,
      color: stableNoise(`${seed}:c`) > 0.78 ? palette.plaza : palette.pathDirt,
    });
  }
}

/** A wide dirt road between two village centres across the open countryside. */
function pushRoad(
  writes: BoxWrite[],
  seedId: string,
  from: Vector3,
  to: Vector3,
  palette: WorldPalette,
): void {
  const direction = to.clone().sub(from);
  direction.y = 0;
  const total = direction.length();
  if (total < BLOCK) return;
  direction.normalize();
  const heading = Math.atan2(direction.x, direction.z);
  const lateralX = direction.z;
  const lateralZ = -direction.x;
  const bend = (stableNoise(`road:${seedId}:bend`) - 0.5) * 6;
  const steps = Math.max(4, Math.floor(total / (BLOCK * 0.7)));
  for (let step = 0; step <= steps; step++) {
    const t = step / steps;
    const seed = `road:${seedId}:${step}`;
    const at = from.clone().addScaledVector(direction, t * total);
    const drift = Math.sin(t * Math.PI) * bend;
    writes.push({
      x: at.x + lateralX * drift,
      y: GROUND_Y + (step % 2 === 0 ? 0.18 : 0.26),
      z: at.z + lateralZ * drift,
      sx: 5.2 + stableNoise(`${seed}:w`) * 0.8,
      sy: 0.4,
      sz: 5.4 + stableNoise(`${seed}:l`) * 0.8,
      rotY: heading + (stableNoise(`${seed}:r`) - 0.5) * 0.18,
      color: stableNoise(`${seed}:c`) > 0.82 ? palette.plaza : palette.pathDirt,
    });
  }
}

export function createPaths(options: PathsOptions): PathsHandle {
  const { islands, plots, links, palette } = options;
  const group = new Group();

  const laneWrites: BoxWrite[] = [];
  const roadWrites: BoxWrite[] = [];

  // Lanes from every door to its own village centre. Thin out for big vaults.
  const laneDetail: WalkwayDetail =
    plots.size > 800
      ? { maxTiles: 10, gap: 1.5, size: 4.6 }
      : plots.size > 300
        ? { maxTiles: 18, gap: 0.95, size: 3.6 }
        : { maxTiles: 44, gap: 0.5, size: 3 };
  for (const plot of plots.values()) {
    const door = options.doorPosition(plot.node.filePath);
    if (door) {
      const centre = new Vector3(plot.island.center.x, GROUND_Y, plot.island.center.z);
      pushLane(laneWrites, plot.node.id, door, centre, palette, laneDetail);
    }
  }

  // Roads tying the villages together: every village connects to the central
  // one (hub-and-spoke), plus a road for each cross-folder link pair, so the
  // countryside reads as one connected settlement.
  const byCluster = new Map<number, IslandSpec>();
  for (const island of islands) byCluster.set(island.clusterIndex, island);
  const central = islands.find((island) => island.center.lengthSq() === 0) ?? islands[0] ?? null;
  const roadPairs = new Set<string>();
  function addRoad(a: IslandSpec, b: IslandSpec): void {
    if (a.clusterIndex === b.clusterIndex) return;
    const key = bridgeKey(a.clusterIndex, b.clusterIndex);
    if (roadPairs.has(key)) return;
    roadPairs.add(key);
    pushRoad(
      roadWrites,
      key,
      new Vector3(a.center.x, GROUND_Y, a.center.z),
      new Vector3(b.center.x, GROUND_Y, b.center.z),
      palette,
    );
  }
  if (central) {
    for (const island of islands) addRoad(central, island);
  }
  for (const link of links) {
    const a = plots.get(link.source)?.island;
    const b = plots.get(link.target)?.island;
    if (a && b) addRoad(a, b);
  }

  const ownedGeometries: BufferGeometry[] = [];
  const staticBatches: VoxelBatch[] = [];
  function buildToon(writes: BoxWrite[], geometry: BufferGeometry): void {
    if (writes.length === 0) {
      geometry.dispose();
      return;
    }
    ownedGeometries.push(geometry);
    const batch = toonBatch(palette, geometry, writes.length, { outline: false });
    for (const write of writes) batch.add(write);
    batch.commit();
    staticBatches.push(batch);
    group.add(batch.mesh);
  }
  // Roads first (wider, underneath), then lanes on top.
  buildToon(roadWrites, new BoxGeometry(1, 1, 1));
  buildToon(laneWrites, new BoxGeometry(1, 1, 1));

  // ── Focus trails (glowing links from the focused note) ──
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
        trails.set(cursor, {
          x: pair.from.x + direction.x * distance * t,
          y: GROUND_Y + 0.45,
          z: pair.from.z + direction.z * distance * t,
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
    trailMaterial.opacity = 0.7 + Math.sin(nowSeconds * 2.6) * 0.18;
  }

  return {
    group,
    bridges: new Map<string, BridgeInfo>(),
    setFocusTrails,
    update,
    dispose: () => {
      for (const batch of staticBatches) batch.dispose();
      for (const geometry of ownedGeometries) geometry.dispose();
      trails.dispose();
    },
  };
}
