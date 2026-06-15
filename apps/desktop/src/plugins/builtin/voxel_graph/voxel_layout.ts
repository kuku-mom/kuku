// ── Agent World Layout ──
//
// Pure, deterministic layout math for the agent world. Every vault folder
// becomes an island floating in the ocean; every note becomes a building plot
// on its folder's island. All placement is derived from stable hashes of node
// ids so the world looks identical across rebuilds and sessions.

import { Vector3 } from "three";

import type { GraphLink, GraphNode, GraphState } from "~/plugins/builtin/graph_view/graph_types";

// ── Units ─────────────────────────────────────────────────────

/** World units per voxel block. Everything in the world snaps to this grid. */
export const BLOCK = 4;

/** Golden angle in radians, used for sunflower plot distribution. */
const GOLDEN_ANGLE = 2.399963229728653;

const UINT32_MAX = 4_294_967_295;

// ── Types ─────────────────────────────────────────────────────

export interface IslandSpec {
  clusterIndex: number;
  name: string;
  /** Island center at water level (y = 0). */
  center: Vector3;
  /** Island footprint radius, in blocks. */
  radiusBlocks: number;
  /** Island top surface height above water, in blocks. */
  elevation: number;
  plotCount: number;
}

/** Building size tier derived from document weight: hut → house → manor → tower. */
export type PlotTier = 0 | 1 | 2 | 3;

export interface PlotSpec {
  node: GraphNode;
  island: IslandSpec;
  /** House footprint center, on the island top surface (y = surface height). */
  position: Vector3;
  /** Door orientation, quantized to 90° steps so houses sit on the grid. */
  rotationY: number;
  tier: PlotTier;
}

export interface VoxelVisibleStats {
  nodes: number;
  links: number;
  totalNodes: number;
  totalLinks: number;
  omittedNodes: number;
  omittedLinks: number;
  capped: boolean;
}

// ── Deterministic noise ───────────────────────────────────────

export function stableHash(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Stable pseudo-random in [0, 1) derived from a string. */
export function stableNoise(value: string): number {
  return stableHash(value) / UINT32_MAX;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function snapToGrid(value: number, step = BLOCK): number {
  return Math.round(value / step) * step;
}

// ── Labels ────────────────────────────────────────────────────

export function shortLabel(name: string): string {
  return name.length > 28 ? `${name.slice(0, 28)}...` : name;
}

export function islandLabelText(folderName: string): string {
  const name = folderName.split("/").filter(Boolean).at(-1) ?? folderName;
  return name.length > 18 ? `${name.slice(0, 18)}...` : name || "Root";
}

// ── Visibility (everything stays visible; instancing carries the load) ──

export function selectVisibleNodes(state: GraphState): GraphNode[] {
  return [...state.nodes];
}

export function selectVisibleLinks(state: GraphState, includedPaths: Set<string>): GraphLink[] {
  return state.links.filter(
    (link) => includedPaths.has(link.source) && includedPaths.has(link.target),
  );
}

export function getVoxelVisibleStats(state: GraphState | null | undefined): VoxelVisibleStats {
  if (!state) {
    return {
      nodes: 0,
      links: 0,
      totalNodes: 0,
      totalLinks: 0,
      omittedNodes: 0,
      omittedLinks: 0,
      capped: false,
    };
  }

  const visibleNodes = selectVisibleNodes(state);
  const includedPaths = new Set(visibleNodes.map((node) => node.filePath));
  const visibleLinks = selectVisibleLinks(state, includedPaths);
  const omittedNodes = Math.max(0, state.nodes.length - visibleNodes.length);
  const omittedLinks = Math.max(0, state.links.length - visibleLinks.length);

  return {
    nodes: visibleNodes.length,
    links: visibleLinks.length,
    totalNodes: state.nodes.length,
    totalLinks: state.links.length,
    omittedNodes,
    omittedLinks,
    capped: omittedNodes > 0 || omittedLinks > 0,
  };
}

export function agentWorldRestoreKey(
  state: Pick<GraphState, "nodes" | "links" | "clusters">,
): string {
  const nodes = [...state.nodes]
    .sort((left, right) => left.filePath.localeCompare(right.filePath))
    .map((node) => [
      node.filePath,
      node.id,
      node.folder,
      node.clusterIndex,
      node.linkCount,
      node.isOrphan,
      node.documentLength ?? null,
    ]);
  const links = [...state.links]
    .sort(
      (left, right) =>
        left.source.localeCompare(right.source) || left.target.localeCompare(right.target),
    )
    .map((link) => [link.source, link.target]);

  return JSON.stringify({ clusters: state.clusters, nodes, links });
}

// ── Island layout ─────────────────────────────────────────────

/** Sunflower spacing between neighbouring plots, in blocks. Wide enough that the
 *  large house footprints never overlap their neighbours. */
const PLOT_SPACING = 5.9;
/** Stone plaza radius at every island center, in blocks. */
export const PLAZA_RADIUS = 3;
/** Grass breathing room kept between neighbouring village (folder) clusters, in
 *  blocks. They sit on ONE continuous landmass with countryside between them —
 *  no water, no gaps to bridge. */
const ISLAND_GAP = 7;
/** The whole world is a single flat plain at this height (in blocks). Everything
 *  — ground, houses, roads, agents — sits at this Y, so nothing can ever clip
 *  through the floor and there are no slopes to fall through. */
export const ISLAND_ELEVATION = 0;

export function islandRadiusForPlots(plotCount: number): number {
  // Island grows with note count; the generous outer margin (+6) leaves room for
  // the half-footprint of the outermost houses plus a grass ring to the shore.
  const sunflowerRadius = PLOT_SPACING * Math.sqrt(Math.max(1, plotCount)) + PLAZA_RADIUS;
  return Math.ceil(clamp(sunflowerRadius + 6, 12, 58));
}

interface IslandSeed {
  clusterIndex: number;
  name: string;
  plotCount: number;
  radiusBlocks: number;
}

/**
 * Places one island per cluster present in `nodes`. The largest island anchors
 * the world center and the rest spiral outward on golden angles, pushed away
 * until no two islands overlap. Deterministic for a given node set.
 */
export function computeIslands(
  nodes: readonly GraphNode[],
  clusters: readonly string[],
): IslandSpec[] {
  const counts = new Map<number, number>();
  for (const node of nodes) {
    counts.set(node.clusterIndex, (counts.get(node.clusterIndex) ?? 0) + 1);
  }
  if (counts.size === 0) counts.set(0, 0);

  const seeds: IslandSeed[] = [...counts.entries()]
    .map(([clusterIndex, plotCount]) => ({
      clusterIndex,
      name: clusters[clusterIndex] ?? "Root",
      plotCount,
      radiusBlocks: islandRadiusForPlots(plotCount),
    }))
    .sort(
      (left, right) =>
        right.plotCount - left.plotCount ||
        left.name.localeCompare(right.name) ||
        left.clusterIndex - right.clusterIndex,
    );

  const placed: IslandSpec[] = [];

  for (const [order, seed] of seeds.entries()) {
    const elevation = ISLAND_ELEVATION;
    if (order === 0) {
      placed.push({
        clusterIndex: seed.clusterIndex,
        name: seed.name,
        center: new Vector3(0, 0, 0),
        radiusBlocks: seed.radiusBlocks,
        elevation,
        plotCount: seed.plotCount,
      });
      continue;
    }

    const angle = order * GOLDEN_ANGLE + (stableNoise(`island-angle:${seed.name}`) - 0.5) * 0.5;
    const direction = new Vector3(Math.cos(angle), 0, Math.sin(angle));
    let distanceBlocks = placed[0].radiusBlocks + seed.radiusBlocks + ISLAND_GAP;

    for (let attempt = 0; attempt < 400; attempt++) {
      const candidate = direction.clone().multiplyScalar(distanceBlocks * BLOCK);
      const collides = placed.some(
        (other) =>
          candidate.distanceTo(other.center) <
          (other.radiusBlocks + seed.radiusBlocks + ISLAND_GAP) * BLOCK,
      );
      if (!collides) {
        placed.push({
          clusterIndex: seed.clusterIndex,
          name: seed.name,
          center: new Vector3(snapToGrid(candidate.x), 0, snapToGrid(candidate.z)),
          radiusBlocks: seed.radiusBlocks,
          elevation,
          plotCount: seed.plotCount,
        });
        break;
      }
      distanceBlocks += 3;
    }

    if (placed.length !== order + 1) {
      // Fallback: park unplaceable islands on an outer ring (should not happen).
      placed.push({
        clusterIndex: seed.clusterIndex,
        name: seed.name,
        center: direction.clone().multiplyScalar(distanceBlocks * BLOCK),
        radiusBlocks: seed.radiusBlocks,
        elevation,
        plotCount: seed.plotCount,
      });
    }
  }

  return placed;
}

export function islandForNode(node: GraphNode, islands: readonly IslandSpec[]): IslandSpec {
  return islands.find((island) => island.clusterIndex === node.clusterIndex) ?? islands[0];
}

/** Island top surface height in world units. */
export function islandSurfaceY(island: IslandSpec): number {
  return island.elevation * BLOCK;
}

// ── Plot layout ───────────────────────────────────────────────

export function plotTierForNode(node: GraphNode): PlotTier {
  const length = Math.max(0, node.documentLength ?? 0);
  let tier: number;
  if (length < 500) tier = 0;
  else if (length < 2_000) tier = 1;
  else if (length < 6_000) tier = 2;
  else tier = 3;
  if (node.linkCount >= 6) tier += 1;
  return clamp(tier, 0, 3) as PlotTier;
}

/**
 * Distributes one plot per node around its village plaza on a sunflower spiral,
 * with a little stable per-house jitter in radius, angle and facing so the
 * village reads as hand-grown and lived-in rather than a rigid wheel — but never
 * enough to overlap neighbours.
 */
export function computePlots(
  nodes: readonly GraphNode[],
  islands: readonly IslandSpec[],
): Map<string, PlotSpec> {
  const plots = new Map<string, PlotSpec>();
  const byIsland = new Map<number, GraphNode[]>();

  for (const node of nodes) {
    const island = islandForNode(node, islands);
    const list = byIsland.get(island.clusterIndex) ?? [];
    list.push(node);
    byIsland.set(island.clusterIndex, list);
  }

  for (const [clusterIndex, islandNodes] of byIsland) {
    const island = islands.find((entry) => entry.clusterIndex === clusterIndex) ?? islands[0];
    const sorted = [...islandNodes].sort((left, right) => left.id.localeCompare(right.id));
    const spin = stableNoise(`island-spin:${island.name}`) * Math.PI * 2;
    const surfaceY = islandSurfaceY(island);

    for (const [index, node] of sorted.entries()) {
      // Stable per-house jitter: a little in and out, a little around, so the
      // ring of homes looks organic instead of mechanically spiralled.
      const jitterR = (stableNoise(`${node.id}:jr`) - 0.5) * PLOT_SPACING * 0.45 * BLOCK;
      const jitterA = (stableNoise(`${node.id}:ja`) - 0.5) * 0.55;
      const radius =
        (PLAZA_RADIUS + 1.6 + PLOT_SPACING * Math.sqrt(index + 0.35)) * BLOCK + jitterR;
      const angle = spin + index * GOLDEN_ANGLE + jitterA;
      const x = island.center.x + Math.cos(angle) * radius;
      const z = island.center.z + Math.sin(angle) * radius;
      const position = new Vector3(snapToGrid(x, BLOCK / 2), surfaceY, snapToGrid(z, BLOCK / 2));

      // Face roughly toward the plaza, snapped to 90° then nudged so the roofs
      // don't all line up dead straight.
      const facing = Math.atan2(island.center.x - position.x, island.center.z - position.z);
      const rotationY =
        (Math.round(facing / (Math.PI / 2)) * Math.PI) / 2 +
        (stableNoise(`${node.id}:jrot`) - 0.5) * 0.4;

      plots.set(node.filePath, {
        node,
        island,
        position,
        rotationY,
        tier: plotTierForNode(node),
      });
    }
  }

  return plots;
}

/** Radius of the whole settled world in world units, used for camera fit. */
export function worldRadius(islands: readonly IslandSpec[]): number {
  let radius = 24 * BLOCK;
  for (const island of islands) {
    radius = Math.max(radius, island.center.length() + island.radiusBlocks * BLOCK);
  }
  return radius;
}
