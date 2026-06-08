// ── Graph View Type Definitions ──
//
// Shared types for the graph-view plugin.
// All reactive state shapes, renderer bridge types, and pure helper functions.

// ── Domain Types ──────────────────────────────────────────────

export interface GraphNode {
  id: string;
  name: string;
  filePath: string;
  folder: string;
  clusterIndex: number;
  linkCount: number;
  isOrphan: boolean;
  /** Optional Agent World metadata, measured from the vault document body. */
  documentLength?: number;
  wordCount?: number;
  lineCount?: number;
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

// ── Renderer Bridge Types ─────────────────────────────────────
//
// Graph renderers mutate node/link objects in place with position and velocity
// fields. We deep-copy domain data into these shapes before handing them to the
// simulation, so the SolidJS store is never mutated by the physics engine.

export interface FGNode extends GraphNode {
  x?: number;
  y?: number;
  z?: number;
  vx?: number;
  vy?: number;
  vz?: number;
  /** Pinned position (set after drag-to-pin). */
  fx?: number | undefined;
  fy?: number | undefined;
  fz?: number | undefined;
  /** Transient: drag start position for click-vs-drag detection. */
  dragStartX?: number;
  dragStartY?: number;
  dragStartZ?: number;
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

export type GraphNodeFilter = (node: GraphNode) => boolean;

export interface GraphFilterOptions {
  preserveClusterIndices?: boolean;
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

export function filterGraphState(
  state: GraphState,
  nodeFilter: GraphNodeFilter | null | undefined,
  options: GraphFilterOptions = {},
): GraphState {
  if (!nodeFilter) return state;

  const sourceNodes = state.nodes.filter(nodeFilter);
  const includedPaths = new Set(sourceNodes.map((node) => node.filePath));
  const links = state.links.filter(
    (link) => includedPaths.has(link.source) && includedPaths.has(link.target),
  );
  const adjacencyMap: Record<string, string[]> = {};
  for (const node of sourceNodes) {
    adjacencyMap[node.filePath] = [];
  }
  for (const link of links) {
    adjacencyMap[link.source]?.push(link.target);
    adjacencyMap[link.target]?.push(link.source);
  }

  const clusters = options.preserveClusterIndices
    ? state.clusters
    : [...new Set(sourceNodes.map((node) => node.folder))].sort();
  const clusterIndexByFolder = new Map(clusters.map((folder, index) => [folder, index]));
  const nodes = sourceNodes.map((node) => {
    const linkCount = adjacencyMap[node.filePath]?.length ?? 0;
    return {
      ...node,
      clusterIndex: options.preserveClusterIndices
        ? node.clusterIndex
        : (clusterIndexByFolder.get(node.folder) ?? 0),
      linkCount,
      isOrphan: linkCount === 0,
    };
  });

  return {
    ...state,
    nodes,
    links,
    adjacencyMap,
    clusters,
  };
}

export function hasGraphPointerTarget(target: unknown): boolean {
  return target !== null && target !== undefined;
}

export const GRAPH_3D_SCROLL_ZOOM_SPEED = 0.85;

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
  linkStrength: number;
  linkDistance: number;

  // ── Simulation ──
  alphaDecay: number;
  velocityDecay: number;
  warmupTicks: number;
  cooldownTicks: number;

  // ── Node sizing ──
  nodeSize: number;
  nodeMinSize: number;
  nodeMaxSize: number;
  nodeSizeScale: number;
  orphanNodeSize: number;

  // ── Links ──
  linkCurvature: number;
  arrowLength: number;

  // ── Display ──
  showArrows: boolean;
  labelVisibilityThreshold: number;
  linkOpacity: number;
  linkWidthScale: number;
  hoverFadeOpacity: number;

  // ── Clusters ──
  clusterPadding: number;
  showClusters: boolean;

  // ── Backlinks ──
  showBacklinks: boolean;
}

export type GraphSettingsScope = "2d" | "3d";

export interface GraphViewSettings {
  twoD: GraphSettings;
  threeD: GraphSettings;
}

export const GRAPH_SETTINGS_DEFAULTS: GraphSettings = {
  // Forces
  chargeStrength: -255,
  chargeStrengthOrphan: -110,
  linkDistanceSameFolder: 38,
  linkDistanceCrossFolder: 320,
  centerStrength: 0.016,
  clusterStrength: 0.5,
  clusterRadiusFactor: 0.68,
  linkStrength: 1,
  linkDistance: 180,

  // Simulation
  alphaDecay: 0.01,
  velocityDecay: 0.3,
  warmupTicks: 80,
  cooldownTicks: 300,

  // Node sizing
  nodeSize: 1,
  nodeMinSize: 3.5,
  nodeMaxSize: 11,
  nodeSizeScale: 0.7,
  orphanNodeSize: 4,

  // Links
  linkCurvature: 0.12,
  arrowLength: 3,

  // Display
  showArrows: false,
  labelVisibilityThreshold: 1.6,
  linkOpacity: 1,
  linkWidthScale: 1,
  hoverFadeOpacity: 0.46,

  // Clusters
  clusterPadding: 38,
  showClusters: true,

  // Backlinks
  showBacklinks: true,
};

export const GRAPH_VIEW_SETTINGS_DEFAULTS: GraphViewSettings = {
  twoD: { ...GRAPH_SETTINGS_DEFAULTS },
  threeD: { ...GRAPH_SETTINGS_DEFAULTS },
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

function mergeGraphViewSettings(raw: unknown): GraphViewSettings {
  if (!isRecord(raw)) {
    return {
      twoD: { ...GRAPH_SETTINGS_DEFAULTS },
      threeD: { ...GRAPH_SETTINGS_DEFAULTS },
    };
  }

  const hasScopedSettings = isRecord(raw.twoD) || isRecord(raw.threeD);
  if (!hasScopedSettings) {
    const legacy = mergeGraphSettings(raw);
    return {
      twoD: { ...legacy },
      threeD: { ...legacy },
    };
  }

  return {
    twoD: mergeGraphSettings(raw.twoD),
    threeD: mergeGraphSettings(raw.threeD),
  };
}

// ── Cluster Palette ───────────────────────────────────────────

const MINERAL_JEWEL_PALETTE = [
  { h: 216, s: 100, l: 78 }, // powder blue
  { h: 258, s: 100, l: 81 }, // soft violet
  { h: 168, s: 53, l: 67 }, // mineral teal
  { h: 33, s: 78, l: 71 }, // muted amber
  { h: 345, s: 64, l: 74 }, // dusty rose
  { h: 88, s: 50, l: 66 }, // moss lime
  { h: 196, s: 70, l: 75 }, // pale cyan
  { h: 286, s: 62, l: 78 }, // orchid
  { h: 14, s: 78, l: 70 }, // coral clay
  { h: 144, s: 48, l: 65 }, // jade
  { h: 232, s: 76, l: 76 }, // periwinkle
  { h: 52, s: 76, l: 69 }, // soft gold
  { h: 316, s: 58, l: 73 }, // mauve pink
  { h: 178, s: 54, l: 66 }, // sea glass
  { h: 272, s: 74, l: 76 }, // amethyst
  { h: 104, s: 44, l: 64 }, // lichen
  { h: 205, s: 58, l: 70 }, // glacier blue
  { h: 6, s: 62, l: 72 }, // rose quartz
  { h: 155, s: 42, l: 62 }, // verdigris
  { h: 44, s: 64, l: 67 }, // honey topaz
  { h: 300, s: 48, l: 72 }, // lilac smoke
  { h: 188, s: 50, l: 64 }, // lagoon
  { h: 24, s: 70, l: 68 }, // apricot copper
  { h: 244, s: 62, l: 74 }, // iris
  { h: 126, s: 38, l: 61 }, // sage emerald
  { h: 332, s: 54, l: 70 }, // berry rose
  { h: 70, s: 52, l: 64 }, // citron mineral
  { h: 224, s: 54, l: 70 }, // denim crystal
  { h: 162, s: 62, l: 72 }, // mint opal
  { h: 358, s: 58, l: 69 }, // soft garnet
  { h: 38, s: 58, l: 63 }, // ochre pearl
  { h: 265, s: 54, l: 72 }, // wisteria
];

const CLUSTER_BG_ALPHA = 0.12;
const CLUSTER_BG_ALPHA_LIGHT = 0.16;

function isLightTheme(): boolean {
  return document.documentElement.getAttribute("data-theme") === "light";
}

function clusterTone(index: number): { h: number; s: number; l: number } {
  const tone = MINERAL_JEWEL_PALETTE[index % MINERAL_JEWEL_PALETTE.length];
  if (!isLightTheme()) return tone;

  return {
    h: tone.h,
    s: Math.min(82, Math.round(tone.s * 1.04)),
    l: Math.max(38, tone.l - 23),
  };
}

const colorCache = new Map<number, string>();
const bgCache = new Map<number, string>();

export function clusterColor(index: number, alpha?: number): string {
  const { h, s, l } = clusterTone(index);
  if (alpha !== undefined) {
    return `hsla(${h}, ${s}%, ${l}%, ${alpha})`;
  }
  const cacheKey = isLightTheme() ? index + 10000 : index;
  let c = colorCache.get(cacheKey);
  if (!c) {
    c = `hsl(${h}, ${s}%, ${l}%)`;
    colorCache.set(cacheKey, c);
  }
  return c;
}

export function clusterBgColor(index: number): string {
  const cacheKey = isLightTheme() ? index + 10000 : index;
  let c = bgCache.get(cacheKey);
  if (!c) {
    const { h, s, l } = clusterTone(index);
    const alpha = isLightTheme() ? CLUSTER_BG_ALPHA_LIGHT : CLUSTER_BG_ALPHA;
    c = `hsla(${h}, ${s}%, ${l}%, ${alpha})`;
    bgCache.set(cacheKey, c);
  }
  return c;
}

/**
 * Cluster color tuned for label text readability.
 * Lightness is theme-driven so light theme uses a darker tone (~38%)
 * while dark theme uses an airy mid (~71%).
 */
export function clusterTextColor(index: number, lightness = "71%"): string {
  const { h, s } = clusterTone(index);
  return `hsl(${h}, ${s}%, ${lightness})`;
}

export { mergeGraphSettings, mergeGraphViewSettings };
