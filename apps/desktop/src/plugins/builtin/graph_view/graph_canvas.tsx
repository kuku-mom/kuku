// ── Graph Canvas ──
//
// SolidJS-idiomatic bridge between the reactive graph store and the
// imperative force-graph Canvas2D renderer.
//
// Key design decisions (mirroring kuku-oss/knowledge_graph.tsx):
//
//   1. `graphEl` is a plain `let` variable — NOT a signal.
//      Making it a signal caused `setGraphEl(fg)` inside onMount to
//      trigger reactive effects synchronously, which ran `instance.graphData()`
//      before force-graph's internal state was fully ready → domNode = null crash.
//
//   2. Data sync effect tracks `store()?.state.lastIndexedAt` (a timestamp)
//      rather than the nodes/links arrays directly or graphEl. This fires
//      exactly once per completed index, never during mid-index state changes.
//
//   3. Cleanup mirrors kuku-oss: pause animation, manually remove child nodes
//      from the container, then set the plain variable to undefined.
//      No `_destructor()` call — Kapsule's destructor sets domNode = null
//      which can race with any in-flight ForceGraph callbacks.

import {
  ClustersIcon,
  FitViewIcon,
  LocateIcon,
  ResetViewIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from "~/components/icons";

import {
  type JSX,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import ForceGraph from "force-graph";

import { t, tf } from "~/i18n";
import { getEffectiveTheme } from "~/stores/theme";

import { getGraphSettings, updateGraphSetting } from "./graph_settings";
import { getGraphStore } from "./graph_store";
import {
  clusterBgColor,
  clusterColor,
  clusterTextColor,
  getGraphSummary,
  type FGLink,
  type FGNode,
  type GraphCanvasHandle,
  type GraphNode,
  type GraphVariant,
} from "./graph_types";

type RenderBudget = "normal" | "dense" | "large" | "huge";

interface GraphBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

const DENSE_GRAPH_NODE_COUNT = 500;
const LARGE_GRAPH_NODE_COUNT = 1_000;
const HUGE_GRAPH_NODE_COUNT = 1_500;
const DENSE_LINK_RATIO = 2.2;
const LARGE_LINK_RATIO = 3;
const HUGE_LINK_RATIO = 4;

// ── Props ─────────────────────────────────────────────────────

interface GraphCanvasProps {
  variant: GraphVariant;
  currentFilePath?: string | null;
  onNodeClick?: (node: GraphNode) => void;
  onNodeRightClick?: (node: GraphNode) => void;
  onBackgroundClick?: () => void;
  /** Callback to receive imperative handle for zoom/fit controls. */
  onHandle?: (handle: GraphCanvasHandle) => void;
  class?: string;
}

// ── Geometry Helpers ──────────────────────────────────────────

function convexHull(points: { x: number; y: number }[]): { x: number; y: number }[] {
  if (points.length < 3) return points;

  let start = 0;
  for (let i = 1; i < points.length; i++) {
    if (
      points[i].y < points[start].y ||
      (points[i].y === points[start].y && points[i].x < points[start].x)
    ) {
      start = i;
    }
  }

  const hull: { x: number; y: number }[] = [];
  let current = start;
  do {
    hull.push(points[current]);
    let next = 0;
    for (let i = 1; i < points.length; i++) {
      if (next === current) {
        next = i;
        continue;
      }
      const cross =
        (points[next].x - points[current].x) * (points[i].y - points[current].y) -
        (points[next].y - points[current].y) * (points[i].x - points[current].x);
      if (cross < 0) next = i;
    }
    current = next;
  } while (current !== start && hull.length < points.length);

  return hull;
}

function expandHull(hull: { x: number; y: number }[], padding: number): { x: number; y: number }[] {
  if (hull.length < 3) return hull;

  const cx = hull.reduce((s, p) => s + p.x, 0) / hull.length;
  const cy = hull.reduce((s, p) => s + p.y, 0) / hull.length;

  return hull.map((p) => {
    const dx = p.x - cx;
    const dy = p.y - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist === 0) return p;
    const scale = (dist + padding) / dist;
    return { x: cx + dx * scale, y: cy + dy * scale };
  });
}

function linkEndpointId(value: string | FGNode): string {
  return typeof value === "object" ? value.filePath : value;
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function budgetNumber(
  budget: RenderBudget,
  values: { normal: number; dense: number; large: number; huge: number },
): number {
  return values[budget];
}

// ── Component ─────────────────────────────────────────────────

export default function GraphCanvas(props: GraphCanvasProps) {
  // ── Plain variables (imperative, not reactive) ─────────────
  //
  // graphEl is intentionally NOT a signal. Storing an imperative
  // canvas library instance in a signal causes its setter to
  // trigger reactive effects mid-initialization, leading to
  // force-graph's domNode being null when graphData() is called.

  let hostEl: HTMLDivElement | undefined;
  let graphEl: ForceGraph | undefined;
  let resizeObs: ResizeObserver | undefined;
  let dragDistance = 0;
  let pendingHoveredNode: FGNode | null | undefined;
  let hoverFrame: number | undefined;
  let lastHugeHoverAt = 0;
  let boundsCache: GraphBounds | null = null;

  // ── Signals (UI state that drives JSX re-renders) ──────────

  const [initError, setInitError] = createSignal<string | null>(null);
  const [hoveredNode, setHoveredNode] = createSignal<FGNode | null>(null);
  const [selectedNode, setSelectedNode] = createSignal<string | null>(null);
  const [zoomLevel, setZoomLevel] = createSignal(1);
  /** Shorthand — reads are fine outside tracking scope (rAF paint callbacks). */
  const cfg = () => getGraphSettings();
  const showClusters = () => cfg().showClusters;
  const [followMode, setFollowMode] = createSignal(false);
  const [dimensions, setDimensions] = createSignal({ width: 400, height: 300 });

  // ── Derived State ──────────────────────────────────────────

  const store = createMemo(() => getGraphStore());
  const isCompact = () => props.variant === "compact";
  const currentFilePath = () => props.currentFilePath ?? null;

  const focusedFilePath = () => hoveredNode()?.filePath ?? selectedNode() ?? currentFilePath();

  const connectedToFocus = createMemo(() => {
    const fp = focusedFilePath();
    const s = store()?.state;
    if (!fp || !s) return new Set<string>();
    return new Set(s.adjacencyMap[fp]);
  });

  const status = createMemo((): "loading" | "error" | "empty" | "ready" => {
    const s = store()?.state;
    if (!s || s.isIndexing) return "loading";
    if (s.error) return "error";
    if (s.nodes.length === 0) return "empty";
    return "ready";
  });

  const summary = createMemo(() => getGraphSummary(store()?.state ?? null));
  const renderBudget = createMemo<RenderBudget>(() => {
    const { nodeCount, linkCount } = summary();
    if (nodeCount >= HUGE_GRAPH_NODE_COUNT || linkCount > nodeCount * HUGE_LINK_RATIO) {
      return "huge";
    }
    if (nodeCount >= LARGE_GRAPH_NODE_COUNT || linkCount > nodeCount * LARGE_LINK_RATIO) {
      return "large";
    }
    if (nodeCount >= DENSE_GRAPH_NODE_COUNT || linkCount > nodeCount * DENSE_LINK_RATIO) {
      return "dense";
    }
    return "normal";
  });
  const isDenseGraph = () => renderBudget() !== "normal";
  const isLargeGraph = () => renderBudget() === "large" || renderBudget() === "huge";
  const isHugeGraph = () => renderBudget() === "huge";

  // ── Theme helpers for Canvas2D ─────────────────────────────
  //
  // `cssVar()` is called from force-graph's rAF paint loop —
  // up to ~5 lookups per node per frame. Caching avoids repeated
  // `getComputedStyle()` calls (a forced layout each time).
  //
  // The cache is invalidated whenever the effective theme flips
  // (see "Effect 6 — Theme repaint" below), and a repaint is
  // poked so labels refresh even if the simulation is cold.

  const cssVarCache = new Map<string, string>();

  /** Resolve a CSS custom property from the host element (e.g. `--color-bg-primary`). */
  function cssVar(name: string, fallback = ""): string {
    if (!hostEl) return fallback;
    const cached = cssVarCache.get(name);
    if (cached !== undefined) return cached;
    const value = getComputedStyle(hostEl).getPropertyValue(name).trim() || fallback;
    cssVarCache.set(name, value);
    return value;
  }

  // ── Canvas Painting ───────────────────────────────────────
  //
  // These functions are called from force-graph's rAF loop —
  // outside any SolidJS tracking scope. Signal reads here return
  // current values without creating subscriptions, which is correct.

  function getClusterGroups(): Map<number, FGNode[]> {
    const groups = new Map<number, FGNode[]>();
    if (!graphEl) return groups;
    const data = graphEl.graphData() as unknown as { nodes: FGNode[] } | undefined;
    if (!data) return groups;

    for (const node of data.nodes) {
      if (node.x === undefined || node.y === undefined) continue;
      const list = groups.get(node.clusterIndex) ?? [];
      list.push(node);
      groups.set(node.clusterIndex, list);
    }
    return groups;
  }

  function invalidateBoundsCache(): void {
    boundsCache = null;
  }

  function visibleGraphBounds(): GraphBounds | null {
    if (!graphEl) return null;
    if (boundsCache) return boundsCache;
    const { width, height } = dimensions();
    if (width <= 0 || height <= 0) return null;

    const graph = graphEl as unknown as {
      screen2GraphCoords?: (x: number, y: number) => { x: number; y: number };
    };
    if (!graph.screen2GraphCoords) return null;

    const margin = isHugeGraph() ? 96 : 160;
    const topLeft = graph.screen2GraphCoords(-margin, -margin);
    const bottomRight = graph.screen2GraphCoords(width + margin, height + margin);
    boundsCache = {
      minX: Math.min(topLeft.x, bottomRight.x),
      maxX: Math.max(topLeft.x, bottomRight.x),
      minY: Math.min(topLeft.y, bottomRight.y),
      maxY: Math.max(topLeft.y, bottomRight.y),
    };
    return boundsCache;
  }

  function isNodeInViewport(node: FGNode): boolean {
    const bounds = visibleGraphBounds();
    if (!bounds || node.x === undefined || node.y === undefined) return true;
    return (
      node.x >= bounds.minX &&
      node.x <= bounds.maxX &&
      node.y >= bounds.minY &&
      node.y <= bounds.maxY
    );
  }

  function isPrimaryNode(node: FGNode): boolean {
    return node.filePath === focusedFilePath();
  }

  function isNeighborhoodNode(node: FGNode): boolean {
    return isPrimaryNode(node) || connectedToFocus().has(node.filePath);
  }

  function isFocusedLink(link: FGLink): boolean {
    const focus = focusedFilePath();
    if (!focus) return false;
    const sourceId = linkEndpointId(link.source);
    const targetId = linkEndpointId(link.target);
    return sourceId === focus || targetId === focus;
  }

  function linkVisible(link: FGLink): boolean {
    if (!isHugeGraph() || isFocusedLink(link)) return true;
    const sourceId = linkEndpointId(link.source);
    const targetId = linkEndpointId(link.target);
    const key = sourceId < targetId ? `${sourceId}\n${targetId}` : `${targetId}\n${sourceId}`;
    return stableHash(key) % (focusedFilePath() ? 10 : 4) === 0;
  }

  function clusterHullPoints(nodes: FGNode[]): { x: number; y: number }[] {
    const positioned = nodes.filter((n) => n.x !== undefined && n.y !== undefined);
    if (!isLargeGraph()) {
      return positioned.map((n) => ({ x: n.x ?? 0, y: n.y ?? 0 }));
    }

    const budget = isHugeGraph() ? 96 : 160;
    if (positioned.length <= budget) {
      return positioned.map((n) => ({ x: n.x ?? 0, y: n.y ?? 0 }));
    }

    const points: { x: number; y: number }[] = [];
    const seen = new Set<string>();
    const add = (node: FGNode) => {
      if (seen.has(node.filePath)) return;
      seen.add(node.filePath);
      points.push({ x: node.x ?? 0, y: node.y ?? 0 });
    };

    for (const node of positioned) {
      if (isNeighborhoodNode(node) || isNodeInViewport(node)) add(node);
      if (points.length >= budget) return points;
    }

    const stride = Math.max(1, Math.ceil(positioned.length / budget));
    for (let i = 0; i < positioned.length && points.length < budget; i += stride) {
      add(positioned[i]);
    }

    return points;
  }

  function paintClusterBackgrounds(ctx: CanvasRenderingContext2D, globalScale: number): void {
    if (!showClusters() || globalScale > 2.5) return;

    const s = store()?.state;
    const groups = getClusterGroups();

    for (const [clusterIdx, nodes] of groups) {
      const points = clusterHullPoints(nodes);

      if (points.length < 1) continue;

      const pad = cfg().clusterPadding / globalScale;

      ctx.beginPath();

      if (points.length === 1) {
        // Single node → circle
        ctx.arc(points[0].x, points[0].y, pad, 0, 2 * Math.PI);
      } else if (points.length === 2) {
        // Two nodes → ellipse along the axis between them
        const cx = (points[0].x + points[1].x) / 2;
        const cy = (points[0].y + points[1].y) / 2;
        const dx = points[1].x - points[0].x;
        const dy = points[1].y - points[0].y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const angle = Math.atan2(dy, dx);
        ctx.ellipse(cx, cy, dist / 2 + pad, pad, angle, 0, 2 * Math.PI);
      } else {
        // 3+ nodes → convex hull polygon
        const hull = convexHull(points);
        const expanded = expandHull(hull, pad);
        if (expanded.length < 3) continue;
        ctx.moveTo(expanded[0].x, expanded[0].y);
        for (let i = 1; i < expanded.length; i++) {
          ctx.lineTo(expanded[i].x, expanded[i].y);
        }
      }

      ctx.closePath();
      ctx.fillStyle = clusterBgColor(clusterIdx);
      if (isLargeGraph()) ctx.globalAlpha = isHugeGraph() ? 0.26 : 0.34;
      ctx.fill();
      ctx.globalAlpha = 1;

      ctx.strokeStyle = clusterColor(clusterIdx, 0.25);
      ctx.lineWidth = (isLargeGraph() ? 0.8 : 1.2) / globalScale;
      ctx.stroke();

      if (globalScale < 1.5 && !isCompact()) {
        const centX = points.reduce((sum, p) => sum + p.x, 0) / points.length;
        const minY = Math.min(...points.map((p) => p.y));

        const fontSize = Math.max(9, Math.min(isLargeGraph() ? 12 : 13, 11 / globalScale));
        ctx.font = `600 ${fontSize}px -apple-system, BlinkMacSystemFont, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";

        const clusterName = s?.clusters[clusterIdx] ?? "Root";
        const shortName = clusterName.split("/").pop() ?? clusterName;
        const label = shortName.length > 14 ? `${shortName.substring(0, 14)}…` : shortName;
        const textWidth = ctx.measureText(label).width;

        const labelY = minY - 22 / globalScale;
        const padI = 5 / globalScale;

        ctx.fillStyle = cssVar("--color-bg-secondary", "rgba(0,0,0,0.55)");
        ctx.beginPath();
        const pillH = fontSize + padI * 2;
        ctx.roundRect(
          centX - textWidth / 2 - padI * 1.5,
          labelY - pillH / 2,
          textWidth + padI * 3,
          pillH,
          2,
        );
        ctx.fill();

        ctx.fillStyle = clusterTextColor(clusterIdx, cssVar("--color-graph-cluster-text-l", "72%"));
        ctx.fillText(label, centX, labelY);
      }
    }
  }

  function paintNode(node: FGNode, ctx: CanvasRenderingContext2D, globalScale: number): void {
    const x = node.x ?? 0;
    const y = node.y ?? 0;
    const isSelected = node.filePath === selectedNode();
    const isHovered = hoveredNode()?.filePath === node.filePath;
    const isCurrent = node.filePath === currentFilePath();
    const isNeighborhood = isNeighborhoodNode(node);
    const cheapBackground = isDenseGraph() && !isNeighborhood;

    if (isHugeGraph() && cheapBackground && !isNodeInViewport(node)) return;

    const { nodeMinSize, nodeMaxSize, nodeSizeScale, orphanNodeSize } = cfg();
    const baseSize = node.isOrphan
      ? orphanNodeSize
      : Math.max(nodeMinSize, Math.min(nodeMaxSize, nodeMinSize + node.linkCount * nodeSizeScale));
    let size = baseSize;
    if (isSelected || isHovered) size = baseSize * 1.3;
    else if (isNeighborhood) size = baseSize * 1.15;

    const nodeClusterColor = clusterColor(node.clusterIndex);
    let fillColor = nodeClusterColor;
    if (node.isOrphan) fillColor = cssVar("--color-graph-node-orphan", "#6a6a6a");
    else if (isSelected) {
      fillColor = cssVar("--color-graph-node-selected", "#f4f4f0");
    } else if (isCurrent) fillColor = cssVar("--color-graph-node-current", "#8b5cf6");

    if (cheapBackground) {
      const backgroundScale = budgetNumber(renderBudget(), {
        normal: 0.82,
        dense: 0.82,
        large: 0.72,
        huge: 0.58,
      });
      const backgroundAlpha = budgetNumber(renderBudget(), {
        normal: 0.68,
        dense: 0.68,
        large: 0.58,
        huge: 0.46,
      });
      ctx.beginPath();
      ctx.arc(x, y, Math.max(1.5, baseSize * backgroundScale), 0, 2 * Math.PI);
      ctx.globalAlpha = backgroundAlpha;
      ctx.fillStyle = fillColor;
      ctx.fill();
      ctx.globalAlpha = 1;
      return;
    }

    if (isSelected || isHovered || isCurrent || isNeighborhood) {
      ctx.beginPath();
      ctx.arc(x, y, size + 3.5, 0, 2 * Math.PI);
      if (isSelected) {
        ctx.globalAlpha = getEffectiveTheme() === "dark" ? 0.19 : 0.11;
      } else {
        ctx.globalAlpha = isNeighborhood && !isHovered ? 0.27 : 0.19;
      }
      ctx.fillStyle = fillColor;
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    ctx.beginPath();
    ctx.arc(x, y, size, 0, 2 * Math.PI);
    ctx.fillStyle = fillColor;
    ctx.fill();

    if (isSelected || isCurrent) {
      ctx.strokeStyle = cssVar("--color-graph-node-stroke-strong", "#d4d4d4");
      if (isSelected && getEffectiveTheme() === "light") {
        ctx.lineWidth = 1.2;
      } else {
        ctx.lineWidth = isSelected ? 2.4 : 1.8;
      }
    } else if (isNeighborhood) {
      ctx.strokeStyle = cssVar("--color-graph-node-stroke-soft", "rgba(212,212,212,0.6)");
      ctx.lineWidth = 1.2;
    } else {
      ctx.strokeStyle = cssVar("--color-graph-node-stroke-faint", "rgba(212,212,212,0.3)");
      ctx.lineWidth = 0.8;
    }
    ctx.stroke();

    const showBackgroundLabel = renderBudget() === "normal" && globalScale > 2;
    const showDenseZoomLabel = renderBudget() === "dense" && globalScale > 3.2;
    const showLabel =
      (isSelected || isCurrent || isNeighborhood || showBackgroundLabel || showDenseZoomLabel) &&
      !isHovered;
    if (showLabel) {
      let baseFontSize = 8;
      if (isSelected || isCurrent) baseFontSize = 10;
      else if (isNeighborhood) baseFontSize = 9;
      const fontSize = Math.max(6, Math.min(baseFontSize, baseFontSize / globalScale ** 0.3));
      ctx.font = `${isNeighborhood ? 500 : 400} ${fontSize}px -apple-system, BlinkMacSystemFont, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";

      let maxLen = 10;
      if (globalScale > 3) maxLen = 20;
      else if (globalScale > 2) maxLen = 14;
      else if (isNeighborhood) maxLen = 12;
      const label = node.name.length > maxLen ? `${node.name.substring(0, maxLen)}…` : node.name;
      const textWidth = ctx.measureText(label).width;
      const pad = 3;
      const labelY = y + size + 3.5;

      ctx.fillStyle = cssVar("--color-bg-secondary", "rgba(0,0,0,0.5)");
      ctx.beginPath();
      ctx.roundRect(
        x - textWidth / 2 - pad,
        labelY - pad,
        textWidth + pad * 2,
        fontSize + pad * 2,
        2,
      );
      ctx.fill();

      ctx.globalAlpha = 0.85;
      ctx.fillStyle = clusterTextColor(
        node.clusterIndex,
        cssVar("--color-graph-cluster-text-l", "72%"),
      );
      ctx.fillText(label, x, labelY);
      ctx.globalAlpha = 1;
    }
  }

  function getLinkColor(link: FGLink): string {
    const sourceId = linkEndpointId(link.source);
    const targetId = linkEndpointId(link.target);
    const sourceNode = typeof link.source === "object" ? link.source : null;
    const focus = focusedFilePath();
    const focused = Boolean(focus && (sourceId === focus || targetId === focus));

    if (isDenseGraph() && !focused) {
      return cssVar(
        "--color-graph-link-default",
        getEffectiveTheme() === "dark" ? "rgba(132,142,158,0.11)" : "rgba(58,65,78,0.1)",
      );
    }

    const sel = selectedNode();
    if (sel && (sourceId === sel || targetId === sel)) {
      return cssVar("--color-graph-link-selected", "rgba(122,176,223,0.75)");
    }

    const cur = currentFilePath();
    if (cur && (sourceId === cur || targetId === cur)) {
      return cssVar("--color-graph-link-current", "rgba(139,92,246,0.75)");
    }

    const hov = hoveredNode();
    if (hov && (sourceId === hov.filePath || targetId === hov.filePath) && sourceNode) {
      return clusterColor(sourceNode.clusterIndex, 0.63);
    }

    if (sourceNode) return clusterColor(sourceNode.clusterIndex, 0.3);

    return cssVar("--color-graph-link-default", "rgba(106,106,106,0.25)");
  }

  function getLinkWidth(link: FGLink): number {
    const sourceId = linkEndpointId(link.source);
    const targetId = linkEndpointId(link.target);

    const sel = selectedNode();
    if (sel && (sourceId === sel || targetId === sel)) return 2;

    const cur = currentFilePath();
    if (cur && (sourceId === cur || targetId === cur)) return 2;

    const hov = hoveredNode();
    if (hov && (sourceId === hov.filePath || targetId === hov.filePath)) return 1.5;

    if (isHugeGraph()) return 0.08;
    if (isLargeGraph()) return 0.18;
    if (isDenseGraph()) return 0.32;
    return 0.8;
  }

  function getLinkArrowLength(link: FGLink): number {
    if (isDenseGraph() && !isFocusedLink(link)) return 0;
    return getGraphSettings().arrowLength;
  }

  function getLinkCurvature(link: FGLink): number {
    if (isDenseGraph() && !isFocusedLink(link)) return 0;
    return getGraphSettings().linkCurvature;
  }

  function alphaDecayForBudget(): number {
    if (isHugeGraph()) return Math.max(getGraphSettings().alphaDecay, 0.16);
    if (isLargeGraph()) return Math.max(getGraphSettings().alphaDecay, 0.07);
    if (isDenseGraph()) return Math.max(getGraphSettings().alphaDecay, 0.04);
    return getGraphSettings().alphaDecay;
  }

  function velocityDecayForBudget(): number {
    if (isHugeGraph()) return Math.max(getGraphSettings().velocityDecay, 0.72);
    if (isLargeGraph()) return Math.max(getGraphSettings().velocityDecay, 0.52);
    if (isDenseGraph()) return Math.max(getGraphSettings().velocityDecay, 0.42);
    return getGraphSettings().velocityDecay;
  }

  function warmupTicksForBudget(): number {
    if (isHugeGraph()) return Math.min(getGraphSettings().warmupTicks, 2);
    if (isLargeGraph()) return Math.min(getGraphSettings().warmupTicks, 12);
    if (isDenseGraph()) return Math.min(getGraphSettings().warmupTicks, 32);
    return getGraphSettings().warmupTicks;
  }

  function cooldownTicksForBudget(): number {
    if (isHugeGraph()) return Math.min(getGraphSettings().cooldownTicks, 8);
    if (isLargeGraph()) return Math.min(getGraphSettings().cooldownTicks, 48);
    if (isDenseGraph()) return Math.min(getGraphSettings().cooldownTicks, 120);
    return getGraphSettings().cooldownTicks;
  }

  // ── Force Configuration ───────────────────────────────────

  function configureForces(options: { reheat?: boolean } = {}): void {
    if (!graphEl) return;

    const s = store()?.state;

    const fc = cfg();
    const budget = renderBudget();
    const dense = budget !== "normal";
    const chargeMultiplier = budgetNumber(budget, {
      normal: 1,
      dense: 0.78,
      large: 0.78,
      huge: 0.58,
    });
    const chargeTheta = budgetNumber(budget, {
      normal: 0.9,
      dense: 1.08,
      large: 1.25,
      huge: 1.5,
    });
    const chargeDistanceMax = budgetNumber(budget, {
      normal: Number.POSITIVE_INFINITY,
      dense: 520,
      large: 320,
      huge: 180,
    });
    const linkDistanceMultiplier = budgetNumber(budget, {
      normal: 1,
      dense: 0.92,
      large: 0.96,
      huge: 0.88,
    });
    const centerMultiplier = budgetNumber(budget, {
      normal: 1,
      dense: 0.78,
      large: 0.62,
      huge: 0.45,
    });
    const clusterRadiusMultiplier = budgetNumber(budget, {
      normal: 1,
      dense: 1.12,
      large: 1.28,
      huge: 1.42,
    });
    const clusterStrengthMultiplier = budgetNumber(budget, {
      normal: 1,
      dense: 0.82,
      large: 0.58,
      huge: 0.38,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chargeForce = graphEl.d3Force("charge") as any;
    chargeForce?.strength(
      (node: FGNode) =>
        (node.isOrphan ? fc.chargeStrengthOrphan : fc.chargeStrength) * chargeMultiplier,
    );
    chargeForce?.theta?.(chargeTheta);
    chargeForce?.distanceMax?.(chargeDistanceMax);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const linkForce = graphEl.d3Force("link") as any;
    linkForce?.distance((link: FGLink) => {
      const source = typeof link.source === "object" ? link.source : null;
      const target = typeof link.target === "object" ? link.target : null;
      if (source && target && source.folder === target.folder) {
        return fc.linkDistanceSameFolder * linkDistanceMultiplier;
      }
      return fc.linkDistanceCrossFolder * linkDistanceMultiplier;
    });
    linkForce?.iterations?.(dense ? 1 : 2);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (graphEl.d3Force("center") as any)?.strength(fc.centerStrength * centerMultiplier);

    const clusters = s?.clusters ?? [];
    if (clusters.length > 1) {
      const { width, height } = dimensions();
      const clusterRadius =
        Math.min(width, height) * fc.clusterRadiusFactor * clusterRadiusMultiplier;
      const angleStep = (2 * Math.PI) / clusters.length;
      const centers = new Map<number, { x: number; y: number }>();

      clusters.forEach((_: string, i: number) => {
        const angle = i * angleStep - Math.PI / 2;
        centers.set(i, {
          x: Math.cos(angle) * clusterRadius,
          y: Math.sin(angle) * clusterRadius,
        });
      });

      const clusterForce = (alpha: number) => {
        const data = graphEl?.graphData() as unknown as { nodes: FGNode[] } | undefined;
        if (!data) return;
        for (const node of data.nodes) {
          const center = centers.get(node.clusterIndex);
          if (!center) continue;
          const strength = fc.clusterStrength * alpha * clusterStrengthMultiplier;
          node.vx = (node.vx ?? 0) + (center.x - (node.x ?? 0)) * strength;
          node.vy = (node.vy ?? 0) + (center.y - (node.y ?? 0)) * strength;
        }
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (graphEl as any).d3Force("cluster", clusterForce);
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (graphEl as any).d3Force("cluster", null);
    }

    if (options.reheat) {
      graphEl.d3ReheatSimulation();
    }
  }

  // ── Zoom Controls ─────────────────────────────────────────

  function zoomIn(): void {
    if (!graphEl) return;
    invalidateBoundsCache();
    const next = Math.min(8, graphEl.zoom() * 1.3);
    graphEl.zoom(next, 300);
    setZoomLevel(next);
  }

  function zoomOut(): void {
    if (!graphEl) return;
    invalidateBoundsCache();
    const next = Math.max(0.1, graphEl.zoom() / 1.3);
    graphEl.zoom(next, 300);
    setZoomLevel(next);
  }

  function fitView(): void {
    if (!graphEl) return;
    invalidateBoundsCache();
    graphEl.zoomToFit(300, 60);
    setTimeout(() => {
      if (graphEl) setZoomLevel(graphEl.zoom());
    }, 350);
  }

  function resetView(): void {
    if (!graphEl) return;
    invalidateBoundsCache();
    const data = graphEl.graphData() as unknown as { nodes: FGNode[] };
    for (const node of data.nodes) {
      node.fx = undefined;
      node.fy = undefined;
    }
    graphEl.centerAt(0, 0, 300);
    graphEl.zoom(1, 300);
    graphEl.d3ReheatSimulation();
    setZoomLevel(1);
  }

  function locateNode(filePath: string): void {
    if (!graphEl) return;
    invalidateBoundsCache();
    const data = graphEl.graphData() as unknown as { nodes: FGNode[] };
    const node = data.nodes.find((n) => n.filePath === filePath);
    if (node?.x !== undefined && node?.y !== undefined) {
      graphEl.centerAt(node.x, node.y, 950);
      graphEl.zoom(2, 950);
      setZoomLevel(2);
    }
  }

  // ── Node Interaction ──────────────────────────────────────

  function handleNodeClick(node: FGNode): void {
    if (dragDistance > 5) return;
    setSelectedNode(node.filePath);
    props.onNodeClick?.(node);
  }

  function handleNodeDrag(node: FGNode): void {
    if (node.dragStartX === undefined) {
      node.dragStartX = node.x;
      node.dragStartY = node.y;
      dragDistance = 0;
    }
    const dx = (node.x ?? 0) - (node.dragStartX ?? 0);
    const dy = (node.y ?? 0) - (node.dragStartY ?? 0);
    dragDistance = Math.sqrt(dx * dx + dy * dy);
  }

  function handleNodeDragEnd(node: FGNode): void {
    if (dragDistance > 5) {
      node.fx = node.x;
      node.fy = node.y;
    }
    node.dragStartX = undefined;
    node.dragStartY = undefined;
    dragDistance = 0;
  }

  // ── Initialization (onMount) ──────────────────────────────
  //
  // Mirrors kuku-oss: `new ForceGraph(containerRef)` with the same
  // ref pattern. graphEl is a plain variable — no signal setter call
  // here, so no reactive effects fire during initialization.

  onMount(() => {
    if (!hostEl) return;

    try {
      graphEl = new ForceGraph(hostEl)
        .nodeId("id")
        .nodeCanvasObject((node, ctx, globalScale) => paintNode(node as FGNode, ctx, globalScale))
        .nodeCanvasObjectMode(() => "replace")
        .nodePointerAreaPaint((node, color, ctx) => {
          const n = node as FGNode;
          if (isHugeGraph() && !isNeighborhoodNode(n) && !isNodeInViewport(n)) return;
          const ns = getGraphSettings();
          const baseSize = Math.max(
            ns.nodeMinSize,
            Math.min(ns.nodeMaxSize, ns.nodeMinSize + n.linkCount * ns.nodeSizeScale),
          );
          const hitArea =
            isHugeGraph() && !isNeighborhoodNode(n)
              ? Math.max(7, baseSize + 2)
              : Math.max(12, baseSize + 6);
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(n.x ?? 0, n.y ?? 0, hitArea, 0, 2 * Math.PI);
          ctx.fill();
        })
        .linkColor((link) => getLinkColor(link as FGLink))
        .linkWidth((link) => getLinkWidth(link as FGLink))
        .linkVisibility((link) => linkVisible(link as FGLink))
        .linkDirectionalArrowLength((link) => getLinkArrowLength(link as FGLink))
        .linkDirectionalArrowRelPos(0.9)
        .linkCurvature((link) => getLinkCurvature(link as FGLink))
        .onNodeClick((node) => handleNodeClick(node as FGNode))
        .onNodeHover((node) => {
          if (isHugeGraph()) {
            const now = performance.now();
            if (now - lastHugeHoverAt < 90) return;
            lastHugeHoverAt = now;
          }
          pendingHoveredNode = (node as FGNode) ?? null;
          if (hoverFrame !== undefined) return;
          hoverFrame = requestAnimationFrame(() => {
            hoverFrame = undefined;
            const next = pendingHoveredNode ?? null;
            pendingHoveredNode = undefined;
            if (hoveredNode()?.filePath === next?.filePath) return;
            setHoveredNode(next);
          });
        })
        .onNodeDrag((node) => handleNodeDrag(node as FGNode))
        .onNodeDragEnd((node) => handleNodeDragEnd(node as FGNode))
        .onBackgroundClick(() => {
          setSelectedNode(null);
          props.onBackgroundClick?.();
        })
        .onRenderFramePre((ctx, globalScale) => paintClusterBackgrounds(ctx, globalScale))
        .onZoom(({ k }) => {
          invalidateBoundsCache();
          setZoomLevel(k);
        })
        .backgroundColor("transparent")
        .d3AlphaDecay(alphaDecayForBudget())
        .d3VelocityDecay(velocityDecayForBudget())
        .warmupTicks(warmupTicksForBudget())
        .cooldownTicks(cooldownTicksForBudget())
        .minZoom(0.1)
        .maxZoom(8)
        .enableNodeDrag(true)
        .enableZoomInteraction(true)
        .enablePanInteraction(true);

      const rect = hostEl.getBoundingClientRect();
      setDimensions({ width: rect.width, height: rect.height });
      graphEl.width(rect.width).height(rect.height);

      resizeObs = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const { width, height } = entry.contentRect;
          setDimensions({ width, height });
          invalidateBoundsCache();
          if (graphEl) {
            graphEl.width(Math.max(1, Math.floor(width)));
            graphEl.height(Math.max(1, Math.floor(height)));
          }
        }
      });
      resizeObs.observe(hostEl);

      props.onHandle?.({ zoomIn, zoomOut, fitView, resetView, locateNode });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // eslint-disable-next-line no-console
      console.error("[GraphCanvas] Init failed:", error);
      setInitError(message);
    }
  });

  // ── Reactive Effects ──────────────────────────────────────
  //
  // Effect 1 — Data sync.
  //
  // Tracks `lastIndexedAt` (a number | null), exactly like kuku-oss.
  // This fires once per completed index run — never during mid-index
  // partial state changes.
  //
  // `graphEl` is read as a plain variable inside the callback
  // (not in the `on()` source), so changing it never re-triggers
  // this effect — only a new completed index does.

  createEffect(
    on(
      () => store()?.state.lastIndexedAt,
      () => {
        if (!graphEl) return;
        const s = store()?.state;
        if (!s || s.nodes.length === 0) return;

        const nodes: FGNode[] = s.nodes.map((n) => ({ ...n }));
        const links: FGLink[] = s.links.map((l) => ({ ...l }));

        graphEl.graphData({ nodes, links });

        requestAnimationFrame(() => configureForces());
      },
    ),
  );

  //
  // Effect 2 — UI repaint.
  //
  // Force ForceGraph to redraw when hover/selection/etc changes.
  // ForceGraph stops rAF when the simulation cools down. Poking
  // `.zoom()` with the current value restarts rendering for one frame.
  // `graphEl` is read as a plain variable — not tracked.

  createEffect(
    on(
      () => [hoveredNode(), selectedNode(), currentFilePath(), showClusters()] as const,
      () => {
        if (graphEl) graphEl.zoom(graphEl.zoom());
      },
      { defer: true },
    ),
  );

  //
  // Effect 3 — Auto-select current file's node.

  createEffect(
    on(
      () => currentFilePath(),
      (fp) => {
        if (fp) setSelectedNode(fp);
        if (graphEl) graphEl.zoom(graphEl.zoom());
      },
      { defer: true },
    ),
  );

  //
  // Effect 4 — Follow mode: auto-locate node when active tab changes (compact only).

  createEffect(() => {
    if (!followMode()) return;
    const fp = currentFilePath();
    if (fp && graphEl) {
      locateNode(fp);
    }
  });

  //
  // Effect 5 — Reconfigure forces & ForceGraph params when settings change.
  //
  // Reads every settings key so any change triggers re-application.
  // `configureForces()` updates d3 forces; the remaining calls update
  // ForceGraph's own parameters that aren't exposed via d3.

  createEffect(() => {
    const s = cfg(); // track all keys
    // Read every field to establish dependency tracking
    void [
      s.chargeStrength,
      s.chargeStrengthOrphan,
      s.linkDistanceSameFolder,
      s.linkDistanceCrossFolder,
      s.centerStrength,
      s.clusterStrength,
      s.clusterRadiusFactor,
      s.alphaDecay,
      s.velocityDecay,
      s.warmupTicks,
      s.cooldownTicks,
      s.nodeMinSize,
      s.nodeMaxSize,
      s.nodeSizeScale,
      s.orphanNodeSize,
      s.linkCurvature,
      s.arrowLength,
      s.clusterPadding,
      s.showClusters,
    ];

    if (!graphEl) return;

    configureForces({ reheat: true });

    graphEl
      .linkVisibility((link) => linkVisible(link as FGLink))
      .linkDirectionalArrowLength((link) => getLinkArrowLength(link as FGLink))
      .linkCurvature((link) => getLinkCurvature(link as FGLink))
      .d3AlphaDecay(alphaDecayForBudget())
      .d3VelocityDecay(velocityDecayForBudget())
      .warmupTicks(warmupTicksForBudget())
      .cooldownTicks(cooldownTicksForBudget());

    // Poke zoom to force a repaint
    graphEl.zoom(graphEl.zoom());
  });

  //
  // Effect 6 — Theme repaint.
  //
  // ForceGraph stops the rAF loop once the simulation cools down.
  // After a theme flip, the `cssVar()` cache is stale AND no paint
  // happens until the user interacts — so labels keep their old
  // colors. Clearing the cache + poking zoom forces one fresh frame
  // with the new theme tokens.

  createEffect(
    on(
      () => getEffectiveTheme(),
      () => {
        cssVarCache.clear();
        if (graphEl) graphEl.zoom(graphEl.zoom());
      },
      { defer: true },
    ),
  );

  // ── Cleanup ───────────────────────────────────────────────
  //
  // Mirrors kuku-oss: pause, manually remove canvas children,
  // then clear the plain variable. No `_destructor()` — calling
  // it sets Kapsule's internal domNode = null, which can race
  // with in-flight rAF callbacks and crash.

  onCleanup(() => {
    if (hoverFrame !== undefined) {
      cancelAnimationFrame(hoverFrame);
      hoverFrame = undefined;
    }
    resizeObs?.disconnect();
    resizeObs = undefined;

    if (graphEl) {
      try {
        graphEl.pauseAnimation();
      } catch {
        /* noop */
      }
      if (hostEl) {
        while (hostEl.firstChild) {
          hostEl.removeChild(hostEl.firstChild);
        }
      }
      graphEl = undefined;
    }
  });

  // ── JSX ───────────────────────────────────────────────────

  return (
    <div
      class={`relative min-h-0 min-w-0 flex-1 overflow-hidden bg-bg-primary ${props.class ?? ""}`}
    >
      {/* Canvas host — ForceGraph appends its <canvas> here */}
      <div ref={hostEl} class="absolute inset-0" />

      {/* Status overlay */}
      <Show when={status() !== "ready" || initError()}>
        <div class="absolute inset-0 flex items-center justify-center p-6">
          <div class="max-w-sm rounded-xs border border-border/70 bg-bg-elevated/90 px-5 py-4 text-center shadow-popover backdrop-blur-sm">
            <Show when={initError()}>
              <p class="text-sm text-text-secondary">{initError()}</p>
            </Show>

            <Show when={!initError() && status() === "loading"}>
              <div class="space-y-2">
                <div class="mx-auto h-2.5 w-24 animate-pulse rounded-xs bg-ghost-hover" />
                <p class="text-sm text-text-secondary">{t("graph.status.indexing")}</p>
              </div>
            </Show>

            <Show when={!initError() && status() === "error"}>
              <p class="text-sm text-text-secondary">
                {store()?.state.error ?? t("graph.status.unknown_error")}
              </p>
            </Show>

            <Show when={!initError() && status() === "empty"}>
              <div class="space-y-2">
                <p class="text-sm text-text-secondary">{t("graph.status.empty")}</p>
                <p class="text-xs text-text-muted">{t("graph.status.empty_hint")}</p>
              </div>
            </Show>

            <div class="mt-4 flex items-center justify-center gap-3 text-[0.6875rem] text-text-muted">
              <span>{tf("graph.tab.metric.nodes", { count: summary().nodeCount })}</span>
              <span>{tf("graph.tab.metric.links", { count: summary().linkCount })}</span>
            </div>
          </div>
        </div>
      </Show>

      {/* Zoom & view controls */}
      <Show when={status() === "ready"}>
        <div
          class="absolute right-3 bottom-3 flex items-center gap-0.5 rounded-xs border border-border/70 bg-bg-elevated/85 p-1 shadow-soft-2 backdrop-blur-sm"
          classList={{ "right-2! bottom-2! gap-0! p-0.5!": isCompact() }}
        >
          <CtrlBtn title={t("graph.ctrl.zoom_in")} onClick={zoomIn} compact={isCompact()}>
            <ZoomInIcon />
          </CtrlBtn>
          <CtrlBtn title={t("graph.ctrl.zoom_out")} onClick={zoomOut} compact={isCompact()}>
            <ZoomOutIcon />
          </CtrlBtn>

          <Show when={!isCompact()}>
            <div class="mx-1 h-4 w-px bg-border" />
            <CtrlBtn
              title={t("graph.ctrl.toggle_clusters")}
              onClick={() => updateGraphSetting("showClusters", !showClusters())}
              active={showClusters()}
            >
              <ClustersIcon />
            </CtrlBtn>
          </Show>

          <CtrlBtn title={t("graph.ctrl.fit_all")} onClick={fitView} compact={isCompact()}>
            <FitViewIcon />
          </CtrlBtn>

          <Show when={isCompact()}>
            <CtrlBtn
              title={followMode() ? t("graph.ctrl.stop_following") : t("graph.ctrl.follow_current")}
              onClick={() => {
                const next = !followMode();
                setFollowMode(next);
                if (next) {
                  const fp = currentFilePath();
                  if (fp) locateNode(fp);
                }
              }}
              active={followMode()}
              compact
            >
              <LocateIcon />
            </CtrlBtn>
          </Show>

          <Show when={!isCompact()}>
            <CtrlBtn title={t("graph.ctrl.reset_view")} onClick={resetView}>
              <ResetViewIcon />
            </CtrlBtn>
            <div class="mx-1 h-4 w-px bg-border" />
          </Show>

          <span
            class="px-1 text-center font-mono text-[0.6875rem] text-text-muted tabular-nums"
            classList={{
              "min-w-11": !isCompact(),
              "min-w-8 text-[0.625rem]": isCompact(),
            }}
          >
            {Math.round(zoomLevel() * 100)}%
          </span>
        </div>
      </Show>

      {/* Tooltip on hover */}
      <Show when={hoveredNode()}>
        {(node) => (
          <div class="pointer-events-none absolute bottom-12 left-3 max-w-56 rounded-xs border border-border/70 bg-bg-elevated/90 px-3 py-2 shadow-popover backdrop-blur-sm">
            <p
              class="truncate text-[0.8125rem] font-medium"
              style={{ color: clusterColor(node().clusterIndex) }}
            >
              {node().name}
            </p>
            <div class="mt-1 flex flex-wrap items-center gap-2 text-[0.6875rem] text-text-muted">
              <span>
                {node().linkCount} connection{node().linkCount !== 1 ? "s" : ""}
              </span>
              <Show when={node().isOrphan}>
                <span class="rounded-xs bg-ghost-hover px-1.5 py-0.5 text-[0.625rem]">
                  {t("graph.badge.unlinked")}
                </span>
              </Show>
              <span
                class="rounded-xs px-1.5 py-0.5 text-[0.625rem]"
                style={{
                  background: clusterColor(node().clusterIndex, 0.13),
                  color: clusterColor(node().clusterIndex),
                }}
              >
                {store()?.state.clusters[node().clusterIndex]?.split("/").pop() ?? "Root"}
              </span>
            </div>
          </div>
        )}
      </Show>
    </div>
  );
}

// ── Control Button ─────────────────────────────────────────────

function CtrlBtn(props: {
  title: string;
  onClick: () => void;
  active?: boolean;
  compact?: boolean;
  children: JSX.Element;
}): JSX.Element {
  return (
    <button
      type="button"
      title={props.title}
      class="flex cursor-pointer items-center justify-center rounded-xs border-none bg-transparent text-[0.75rem] text-text-muted transition-colors duration-100 hover:bg-ghost-hover hover:text-text-primary"
      classList={{
        "size-7": !props.compact,
        "size-6": props.compact,
        "bg-ghost-active! text-text-accent!": props.active,
      }}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}
