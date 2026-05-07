// ── Graph View Type Definitions ──
//
// Shared types for the graph-view plugin.
// All reactive state shapes, force-graph bridge types, and pure helper functions.

// ── Domain Types ──────────────────────────────────────────────

export interface GraphNode {
  id: string;
  name: string;
  filePath: string;
  folder: string;
  clusterIndex: number;
  linkCount: number;
  isOrphan: boolean;
}

export interface GraphLink {
  source: string;
  target: string;
}

// ── Reactive State (SolidJS store shape) ──────────────────────

export interface GraphState {
  nodes: GraphNode[];
  links: GraphLink[];
  adjacencyMap: Record<string, string[]>;
  clusters: string[];
  isIndexing: boolean;
  lastIndexedAt: number | null;
  error: string | null;
}

// ── Store Interface ───────────────────────────────────────────

/**
 * Public API surface of the graph store.
 *
 * `state` is a SolidJS store proxy — property reads inside
 * `createEffect` / `createMemo` / JSX are automatically tracked.
 * Always access properties lazily (e.g. `store.state.nodes`),
 * never destructure at the top level.
 */
export interface GraphStoreLike {
  readonly state: GraphState;
  buildGraphData(): Promise<void>;
  scheduleRebuild(): void;
  clear(): void;
  dispose(): void;
}

// ── Force-Graph Bridge Types ──────────────────────────────────
//
// `force-graph` mutates node/link objects in place with position
// and velocity fields. We deep-copy domain data into these shapes
// before handing them to the simulation, so the SolidJS store
// is never mutated by the physics engine.

export interface FGNode extends GraphNode {
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  /** Pinned position (set after drag-to-pin). */
  fx?: number | undefined;
  fy?: number | undefined;
  /** Transient: drag start position for click-vs-drag detection. */
  dragStartX?: number;
  dragStartY?: number;
}

export interface FGLink {
  source: string | FGNode;
  target: string | FGNode;
}

// ── View Props ────────────────────────────────────────────────

export type GraphVariant = "full" | "compact";

export interface GraphCanvasHandle {
  zoomIn(): void;
  zoomOut(): void;
  fitView(): void;
  resetView(): void;
  locateNode(filePath: string): void;
}

// ── Pure Helpers (no SolidJS dependency) ──────────────────────

export interface GraphSummary {
  nodeCount: number;
  linkCount: number;
  orphanCount: number;
  clusterCount: number;
}

export function getGraphSummary(state: GraphState | null | undefined): GraphSummary {
  if (!state) {
    return { nodeCount: 0, linkCount: 0, orphanCount: 0, clusterCount: 0 };
  }
  return {
    nodeCount: state.nodes.length,
    linkCount: state.links.length,
    orphanCount: state.nodes.filter((n) => n.isOrphan).length,
    clusterCount: state.clusters.length,
  };
}

export function hasGraphData(state: GraphState | null | undefined): boolean {
  return (state?.nodes.length ?? 0) > 0;
}

// ── Graph Settings ────────────────────────────────────────────

export interface GraphSettings {
  // ── Forces ──
  chargeStrength: number;
  chargeStrengthOrphan: number;
  linkDistanceSameFolder: number;
  linkDistanceCrossFolder: number;
  centerStrength: number;
  clusterStrength: number;
  clusterRadiusFactor: number;

  // ── Simulation ──
  alphaDecay: number;
  velocityDecay: number;
  warmupTicks: number;
  cooldownTicks: number;

  // ── Node sizing ──
  nodeMinSize: number;
  nodeMaxSize: number;
  nodeSizeScale: number;
  orphanNodeSize: number;

  // ── Links ──
  linkCurvature: number;
  arrowLength: number;

  // ── Clusters ──
  clusterPadding: number;
  showClusters: boolean;

  // ── Backlinks ──
  showBacklinks: boolean;
}

export const GRAPH_SETTINGS_DEFAULTS: GraphSettings = {
  // Forces
  chargeStrength: -200,
  chargeStrengthOrphan: -80,
  linkDistanceSameFolder: 50,
  linkDistanceCrossFolder: 180,
  centerStrength: 0.03,
  clusterStrength: 0.25,
  clusterRadiusFactor: 0.4,

  // Simulation
  alphaDecay: 0.01,
  velocityDecay: 0.3,
  warmupTicks: 80,
  cooldownTicks: 300,

  // Node sizing
  nodeMinSize: 3.5,
  nodeMaxSize: 11,
  nodeSizeScale: 0.7,
  orphanNodeSize: 4,

  // Links
  linkCurvature: 0.12,
  arrowLength: 3,

  // Clusters
  clusterPadding: 50,
  showClusters: true,

  // Backlinks
  showBacklinks: true,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeGraphSettings(raw: unknown): GraphSettings {
  if (!isRecord(raw)) return { ...GRAPH_SETTINGS_DEFAULTS };

  const merged = { ...GRAPH_SETTINGS_DEFAULTS } as Record<
    keyof GraphSettings,
    GraphSettings[keyof GraphSettings]
  >;
  for (const key of Object.keys(GRAPH_SETTINGS_DEFAULTS) as (keyof GraphSettings)[]) {
    const next = raw[key];
    if (typeof next === typeof GRAPH_SETTINGS_DEFAULTS[key]) {
      merged[key] = next as GraphSettings[keyof GraphSettings];
    }
  }
  return merged as GraphSettings;
}

// ── Cluster Palette ───────────────────────────────────────────

// ── Infinite cluster color generation ────────────────────────
//
// Uses the golden angle (~137.508°) to distribute hues maximally apart,
// so any number of clusters always gets visually distinct colors.

const GOLDEN_ANGLE = 137.508;

function clusterHue(index: number): number {
  return (index * GOLDEN_ANGLE) % 360;
}

const colorCache = new Map<number, string>();
const bgCache = new Map<number, string>();

export function clusterColor(index: number, alpha?: number): string {
  if (alpha !== undefined) {
    return `hsla(${clusterHue(index)}, 72%, 62%, ${alpha})`;
  }
  let c = colorCache.get(index);
  if (!c) {
    c = `hsl(${clusterHue(index)}, 72%, 62%)`;
    colorCache.set(index, c);
  }
  return c;
}

export function clusterBgColor(index: number): string {
  let c = bgCache.get(index);
  if (!c) {
    c = `hsla(${clusterHue(index)}, 72%, 62%, 0.12)`;
    bgCache.set(index, c);
  }
  return c;
}

/**
 * Cluster color tuned for label text readability.
 * Lightness is theme-driven so light theme uses a darker tone (~38%)
 * while dark theme keeps the vivid 62%.
 */
export function clusterTextColor(index: number, lightness = "62%"): string {
  return `hsl(${clusterHue(index)}, 72%, ${lightness})`;
}

export { mergeGraphSettings };
