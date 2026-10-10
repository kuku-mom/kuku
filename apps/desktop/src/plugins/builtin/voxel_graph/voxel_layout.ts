// ── Agent World Layout ──
//
// Pure, deterministic layout math for the agent world. Every vault folder
// becomes a colorful district on a shared harbor promenade; every note becomes a building plot
// on its folder's island. All placement is derived from stable hashes of node
// ids so the world looks identical across rebuilds and sessions.

import { Vector3 } from "three";

import type { GraphLink, GraphNode, GraphState } from "~/plugins/builtin/graph_view/graph_types";

// ── Units ─────────────────────────────────────────────────────

/** World units per voxel block. Everything in the world snaps to this grid. */
export const BLOCK = 4;

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

/** Shared flat promenade. District envelopes also bound agent wandering. */
export const PLAZA_RADIUS = 3;
export const ISLAND_ELEVATION = 0;
export function islandRadiusForPlots(plotCount: number): number {
  const columns = Math.ceil(Math.sqrt(Math.max(1, plotCount)));
  return Math.ceil((Math.hypot((columns - 1) * 16, (columns - 1) * 16 + 12) + 28) / BLOCK);
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
      (left, right) => right.plotCount - left.plotCount || left.clusterIndex - right.clusterIndex,
    );

  const placed: IslandSpec[] = [];
  // Districts occupy a balanced grid, with the largest archive at the rear.
  // Row widths are measured from envelopes so even large folders cannot overlap.
  const columns = seeds.length <= 3 ? seeds.length : Math.ceil(Math.sqrt(seeds.length));
  let z = 0;
  for (let row = 0; row < Math.ceil(seeds.length / columns); row++) {
    const items = seeds.slice(row * columns, (row + 1) * columns);
    const depth = Math.max(...items.map((s) => s.radiusBlocks)) * BLOCK;
    const width =
      items.reduce(
        (sum, s) =>
          sum +
          Math.max(
            s.radiusBlocks * BLOCK * 1.4,
            (Math.ceil(Math.sqrt(Math.max(1, s.plotCount))) - 1) * 32 + 34,
          ) +
          8,
        0,
      ) - 8;
    let x = -width / 2;
    for (const seed of items) {
      const r =
        Math.max(
          seed.radiusBlocks * BLOCK * 1.4,
          (Math.ceil(Math.sqrt(Math.max(1, seed.plotCount))) - 1) * 32 + 34,
        ) / 2;
      placed.push({
        ...seed,
        center: new Vector3(x + r, 0, z + depth),
        elevation: ISLAND_ELEVATION,
      });
      x += r * 2 + 8;
    }
    z += depth * 2 + 8;
  }
  const midZ = z / 2 - 4;
  for (const island of placed) island.center.z -= midZ;

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
 * Places stable note plots in district rows, leaving walkable streets between
 * building footprints and room for the central library.
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
    const surfaceY = islandSurfaceY(island);
    const columns = Math.ceil(Math.sqrt(sorted.length));
    const rows = Math.ceil(sorted.length / columns);
    for (const [index, node] of sorted.entries()) {
      const col = index % columns,
        row = Math.floor(index / columns);
      const position = new Vector3(
        island.center.x + (col - (columns - 1) / 2) * 32,
        surfaceY,
        island.center.z + (row - (rows - 1) / 2) * 32 - 12,
      );
      // Front doors open onto the promenade. Orthogonal rooflines are deliberate.
      const rotationY = 0;

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
