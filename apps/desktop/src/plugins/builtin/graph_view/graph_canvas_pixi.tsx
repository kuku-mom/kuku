// ── Graph Canvas Pixi ──
//
// WebGL-backed 2D graph renderer. This keeps the same public handle as the
// Canvas2D renderer, but avoids per-frame Canvas2D paint callbacks for every
// node/link. Layout is deterministic and cluster-first: folders get stable
// regions, then nodes are placed inside those regions with a golden-angle pack.

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
  untrack,
} from "solid-js";
import { Application, Container, Graphics, Text } from "pixi.js";

import { currentLocale, t, tf } from "~/i18n";
import { settingsState } from "~/stores/settings";
import { getEffectiveTheme } from "~/stores/theme";

import { graphAnimationReplayRevision } from "./graph_animation";
import { getGraphSettings, updateGraphSetting } from "./graph_settings";
import { getGraphStore } from "./graph_store";
import {
  graphNodeLocalGap,
  graphNodePairRepulsionRadius,
  graphNodePairRepulsionStrength,
  type GraphRenderBudget,
} from "./graph_layout";
import {
  clusterBgColor,
  clusterColor,
  clusterTextColor,
  filterGraphState,
  getGraphSummary,
  type GraphCanvasHandle,
  type GraphLink,
  type GraphNode,
  type GraphNodeFilter,
  type GraphVariant,
} from "./graph_types";

type RenderBudget = GraphRenderBudget;

interface GraphCanvasProps {
  variant: GraphVariant;
  currentFilePath?: string | null;
  onNodeClick?: (node: GraphNode) => void;
  onNodeRightClick?: (node: GraphNode) => void;
  onBackgroundClick?: () => void;
  onHandle?: (handle: GraphCanvasHandle) => void;
  initialFollowMode?: boolean;
  initialShowClusters?: boolean;
  nodeFilter?: GraphNodeFilter;
  preserveFilteredClusterColors?: boolean;
  emptyTitle?: string;
  emptyHint?: string;
  hideFollowControl?: boolean;
  hideZoomLabel?: boolean;
  class?: string;
}

interface LayoutNode extends GraphNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
  homeX: number;
  homeY: number;
}

interface LayoutLink {
  source: LayoutNode;
  target: LayoutNode;
}

interface ViewState {
  x: number;
  y: number;
  scale: number;
}

interface DrawOptions {
  links?: boolean;
  clusters?: boolean;
}

interface ClusterLayout {
  index: number;
  nodes: GraphNode[];
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
}

interface ClusterEdge {
  source: ClusterLayout;
  target: ClusterLayout;
  weight: number;
}

const DENSE_GRAPH_NODE_COUNT = 500;
const LARGE_GRAPH_NODE_COUNT = 1_000;
const HUGE_GRAPH_NODE_COUNT = 1_500;
const DENSE_LINK_RATIO = 2.2;
const LARGE_LINK_RATIO = 3;
const HUGE_LINK_RATIO = 4;
const LABEL_FONT_FALLBACK = '"Goorm Sans", -apple-system, BlinkMacSystemFont, sans-serif';
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const UINT32_MAX = 4_294_967_295;

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
    const dist = Math.hypot(dx, dy);
    if (dist === 0) return p;
    const scale = (dist + padding) / dist;
    return { x: cx + dx * scale, y: cy + dy * scale };
  });
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function stableNoise(value: string): number {
  return stableHash(value) / UINT32_MAX;
}

function budgetNumber(
  budget: RenderBudget,
  values: { normal: number; dense: number; large: number; huge: number },
): number {
  return values[budget];
}

function nodeRadius(node: GraphNode, compact = false): number {
  const settings = getGraphSettings();
  const minSize = compact ? Math.max(settings.nodeMinSize, 10) : settings.nodeMinSize;
  if (node.isOrphan)
    return (
      (compact ? Math.max(settings.orphanNodeSize, 10) : settings.orphanNodeSize) *
      settings.nodeSize
    );
  const degreeBoost = Math.sqrt(Math.max(0, node.linkCount)) * settings.nodeSizeScale * 1.65;
  const radiusCap = Math.max(settings.nodeMaxSize, minSize * 2.8, 16);
  return Math.max(minSize, Math.min(radiusCap, minSize + degreeBoost)) * settings.nodeSize;
}

function shortLabel(name: string, max = 14): string {
  return name.length > max ? `${name.slice(0, max)}...` : name;
}

function alphaWithSetting(alpha: number): number {
  return Math.min(1, alpha * getGraphSettings().linkOpacity);
}

function easeInOutCubic(progress: number): number {
  return progress < 0.5 ? 4 * progress * progress * progress : 1 - (-2 * progress + 2) ** 3 / 2;
}

function easeOutCubic(progress: number): number {
  return 1 - (1 - progress) ** 3;
}

function normalizedWheelDelta(event: WheelEvent): number {
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) return event.deltaY * 16;
  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) return event.deltaY * 800;
  return event.deltaY;
}

export default function GraphCanvasPixi(props: GraphCanvasProps): JSX.Element {
  let hostEl: HTMLDivElement | undefined;
  let app: Application | undefined;
  let world: Container | undefined;
  let clusterLayer: Graphics | undefined;
  let linkLayer: Graphics | undefined;
  let nodeLayer: Graphics | undefined;
  let labelLayer: Container | undefined;
  let resizeObs: ResizeObserver | undefined;
  let destroyed = false;
  let renderFrame: number | undefined;
  let viewAnimationFrame: number | undefined;
  let viewInertiaFrame: number | undefined;
  let layoutRelaxFrame: number | undefined;
  let layoutRelaxTicks = 0;
  let layoutRelaxCooling = 1;
  let layoutRelaxDrawTick = 0;
  let redrawLinksOnNextDraw = true;
  let redrawClustersOnNextDraw = true;
  let hoverFrame: number | undefined;
  let dragStart: {
    x: number;
    y: number;
    lastX: number;
    lastY: number;
    lastAt: number;
    velocityX: number;
    velocityY: number;
    view: ViewState;
  } | null = null;
  let nodeDrag: {
    node: LayoutNode;
    startClientX: number;
    startClientY: number;
    startNodeX: number;
    startNodeY: number;
    lastNodeX: number;
    lastNodeY: number;
    distance: number;
  } | null = null;
  let currentLayout: { nodes: LayoutNode[]; links: LayoutLink[] } = { nodes: [], links: [] };
  let view: ViewState = { x: 0, y: 0, scale: 1 };

  const [initError, setInitError] = createSignal<string | null>(null);
  const [hoveredNode, setHoveredNode] = createSignal<LayoutNode | null>(null);
  const [selectedNode, setSelectedNode] = createSignal<string | null>(null);
  const [zoomLevel, setZoomLevel] = createSignal(1);
  const [followMode, setFollowMode] = createSignal(props.initialFollowMode ?? false);
  const [dimensions, setDimensions] = createSignal({ width: 400, height: 300 });

  const store = createMemo(() => getGraphStore());
  const isCompact = () => props.variant === "compact";
  const currentFilePath = () => props.currentFilePath ?? null;
  const [compactShowClusters, setCompactShowClusters] = createSignal(
    props.initialShowClusters ?? false,
  );
  const showClusters = () =>
    isCompact() ? compactShowClusters() : getGraphSettings().showClusters;
  const focusedFilePath = () => hoveredNode()?.filePath ?? selectedNode() ?? currentFilePath();
  const showFollowControl = () => !props.hideFollowControl;
  const showZoomLabel = () => !props.hideZoomLabel;

  const graphState = createMemo(() => {
    const state = store()?.state;
    return state
      ? filterGraphState(state, props.nodeFilter, {
          preserveClusterIndices: props.preserveFilteredClusterColors,
        })
      : null;
  });
  const summary = createMemo(() => getGraphSummary(graphState()));
  const layoutRevision = createMemo(() => {
    const state = graphState();
    return state
      ? [state.lastIndexedAt, state.nodes.length, state.links.length, state.clusters.length]
      : [null, 0, 0, 0];
  });
  const status = createMemo((): "loading" | "error" | "empty" | "ready" => {
    const s = store()?.state;
    if (!s || s.isIndexing) return "loading";
    if (s.error) return "error";
    if ((graphState()?.nodes.length ?? 0) === 0) return "empty";
    return "ready";
  });

  const renderBudget = createMemo<RenderBudget>(() => {
    const { nodeCount, linkCount } = summary();
    if (nodeCount >= HUGE_GRAPH_NODE_COUNT || linkCount > nodeCount * HUGE_LINK_RATIO)
      return "huge";
    if (nodeCount >= LARGE_GRAPH_NODE_COUNT || linkCount > nodeCount * LARGE_LINK_RATIO)
      return "large";
    if (nodeCount >= DENSE_GRAPH_NODE_COUNT || linkCount > nodeCount * DENSE_LINK_RATIO)
      return "dense";
    return "normal";
  });

  const connectedToFocus = createMemo(() => {
    const fp = focusedFilePath();
    const s = graphState();
    if (!fp || !s) return new Set<string>();
    return new Set(s.adjacencyMap[fp]);
  });

  function isFocusedNode(node: LayoutNode): boolean {
    return node.filePath === focusedFilePath();
  }

  function isNeighborhoodNode(node: LayoutNode): boolean {
    return isFocusedNode(node) || connectedToFocus().has(node.filePath);
  }

  function isHighlightedNode(node: LayoutNode): boolean {
    return (
      node.filePath === currentFilePath() ||
      node.filePath === selectedNode() ||
      hoveredNode()?.filePath === node.filePath
    );
  }

  function isSoftHighlightedNode(node: LayoutNode): boolean {
    return isHighlightedNode(node) || connectedToFocus().has(node.filePath);
  }

  function isFocusedLink(link: LayoutLink): boolean {
    const focus = focusedFilePath();
    return Boolean(focus && (link.source.filePath === focus || link.target.filePath === focus));
  }

  function linkFocusFilePath(): string | null {
    return hoveredNode()?.filePath ?? selectedNode();
  }

  function hasExplicitLinkFocus(): boolean {
    const selected = selectedNode();
    return Boolean(hoveredNode() || (selected && selected !== currentFilePath()));
  }

  function isLinkFocusLink(link: LayoutLink): boolean {
    const focus = linkFocusFilePath();
    return Boolean(focus && (link.source.filePath === focus || link.target.filePath === focus));
  }

  function isHighlightedLink(link: LayoutLink): boolean {
    const sourceId = link.source.filePath;
    const targetId = link.target.filePath;
    const selected = selectedNode();
    const current = currentFilePath();
    const hovered = hoveredNode()?.filePath;
    return Boolean(
      (selected && (sourceId === selected || targetId === selected)) ||
      (current && (sourceId === current || targetId === current)) ||
      (hovered && (sourceId === hovered || targetId === hovered)),
    );
  }

  function selectedLayoutNode(): LayoutNode | undefined {
    const selected = selectedNode();
    if (!selected) return undefined;
    return currentLayout.nodes.find((node) => node.filePath === selected);
  }

  function pinFocusNode(filePath: string): void {
    const node = currentLayout.nodes.find((item) => item.filePath === filePath);
    if (!node) return;
    node.homeX = node.x;
    node.homeY = node.y;
    node.vx = 0;
    node.vy = 0;
  }

  function isDenseGraph(): boolean {
    return renderBudget() !== "normal";
  }

  function isLargeGraph(): boolean {
    return renderBudget() === "large" || renderBudget() === "huge";
  }

  function isHugeGraph(): boolean {
    return renderBudget() === "huge";
  }

  function hoverFadeActive(): boolean {
    return Boolean(hoveredNode() && !selectedNode());
  }

  function cssVar(name: string, fallback = ""): string {
    if (!hostEl) return fallback;
    return getComputedStyle(hostEl).getPropertyValue(name).trim() || fallback;
  }

  function labelFontFamily(): string {
    return cssVar("--font-editor", LABEL_FONT_FALLBACK);
  }

  function defaultLinkColor(theme: "dark" | "light"): string {
    if (theme === "dark") return cssVar("--color-graph-link-default", "#b8bdc4");
    return "#d2d6dd";
  }

  function buildLayout(nodes: GraphNode[], links: GraphLink[], clusters: string[]): void {
    const byCluster = new Map<number, GraphNode[]>();
    const graphNodeByPath = new Map<string, GraphNode>();
    for (const node of nodes) {
      const list = byCluster.get(node.clusterIndex) ?? [];
      list.push(node);
      byCluster.set(node.clusterIndex, list);
      graphNodeByPath.set(node.filePath, node);
    }

    const clusterEntries = [...byCluster.entries()]
      .filter(([, clusterNodes]) => clusterNodes.length > 0)
      .sort((a, b) => b[1].length - a[1].length || a[0] - b[0]);
    const clusterCount = Math.max(1, clusterEntries.length, clusters.length);
    const settings = getGraphSettings();
    const budget = renderBudget();
    const distanceScale = settings.linkDistance / 180;
    const localGap = graphNodeLocalGap(settings, budget);
    const clusterGap =
      budgetNumber(budget, {
        normal: 88,
        dense: 72,
        large: 58,
        huge: 44,
      }) * Math.max(0.75, Math.min(1.45, distanceScale));
    const clusterLayouts: ClusterLayout[] = clusterEntries.map(
      ([clusterIndex, clusterNodes], i) => {
        const angle = i * GOLDEN_ANGLE - Math.PI / 2;
        const seedRadius = Math.sqrt(i) * (clusterGap + Math.sqrt(clusterNodes.length) * localGap);
        return {
          index: clusterIndex,
          nodes: clusterNodes,
          x: Math.cos(angle) * seedRadius,
          y: Math.sin(angle) * seedRadius,
          vx: 0,
          vy: 0,
          radius: Math.max(34, Math.sqrt(clusterNodes.length) * localGap * 1.22 + 18),
        };
      },
    );
    const clusterByIndex = new Map(clusterLayouts.map((cluster) => [cluster.index, cluster]));
    const edgeWeights = new Map<string, { source: number; target: number; weight: number }>();
    for (const link of links) {
      const source = graphNodeByPath.get(link.source);
      const target = graphNodeByPath.get(link.target);
      if (!source || !target || source.clusterIndex === target.clusterIndex) continue;
      const low = Math.min(source.clusterIndex, target.clusterIndex);
      const high = Math.max(source.clusterIndex, target.clusterIndex);
      const key = `${low}:${high}`;
      const edge = edgeWeights.get(key) ?? { source: low, target: high, weight: 0 };
      edge.weight += 1;
      edgeWeights.set(key, edge);
    }
    const clusterEdges: ClusterEdge[] = [...edgeWeights.values()]
      .map((edge) => {
        const source = clusterByIndex.get(edge.source);
        const target = clusterByIndex.get(edge.target);
        return source && target ? { source, target, weight: edge.weight } : null;
      })
      .filter((edge): edge is ClusterEdge => edge !== null);

    const simulationSteps = Math.max(
      24,
      Math.min(
        getGraphSettings().warmupTicks,
        budgetNumber(budget, {
          normal: 320,
          dense: 280,
          large: 220,
          huge: 170,
        }),
      ),
    );
    for (let step = 0; step < simulationSteps; step++) {
      const cooling = 1 - step / simulationSteps;
      for (let i = 0; i < clusterLayouts.length; i++) {
        for (let j = i + 1; j < clusterLayouts.length; j++) {
          const a = clusterLayouts[i];
          const b = clusterLayouts[j];
          let dx = b.x - a.x;
          let dy = b.y - a.y;
          let dist = Math.hypot(dx, dy);
          if (dist < 0.001) {
            dx = stableNoise(`${a.index}:${b.index}:x`) - 0.5;
            dy = stableNoise(`${a.index}:${b.index}:y`) - 0.5;
            dist = Math.hypot(dx, dy) || 1;
          }
          const nx = dx / dist;
          const ny = dy / dist;
          const target = a.radius + b.radius + clusterGap;
          const chargeScale = Math.min(
            1.8,
            Math.max(0.35, Math.abs(settings.chargeStrength) / 255),
          );
          const overlapForce = Math.max(0, target - dist) * 0.024 * chargeScale;
          const chargeForce =
            Math.min(3.8, (target * target) / (dist * dist + 1)) * 0.09 * chargeScale;
          const force = (overlapForce + chargeForce) * cooling;
          a.vx -= nx * force;
          a.vy -= ny * force;
          b.vx += nx * force;
          b.vy += ny * force;
        }
      }

      for (const edge of clusterEdges) {
        const dx = edge.target.x - edge.source.x;
        const dy = edge.target.y - edge.source.y;
        const dist = Math.hypot(dx, dy) || 1;
        const nx = dx / dist;
        const ny = dy / dist;
        const strength = Math.min(7, Math.log2(edge.weight + 1));
        const target = edge.source.radius + edge.target.radius + clusterGap / (1 + strength * 0.26);
        const force = (dist - target) * 0.0032 * strength * settings.clusterStrength * cooling;
        edge.source.vx += nx * force;
        edge.source.vy += ny * force;
        edge.target.vx -= nx * force;
        edge.target.vy -= ny * force;
      }

      for (const cluster of clusterLayouts) {
        cluster.vx += -cluster.x * settings.centerStrength * 0.15 * cooling;
        cluster.vy += -cluster.y * settings.centerStrength * 0.15 * cooling;
        const damping = Math.max(0.62, Math.min(0.9, 1 - settings.velocityDecay * 0.6));
        cluster.vx *= damping;
        cluster.vy *= damping;
        cluster.x += cluster.vx;
        cluster.y += cluster.vy;
      }
    }

    const layoutNodes: LayoutNode[] = [];
    const nodeByPath = new Map<string, LayoutNode>();

    for (const cluster of clusterLayouts.sort((a, b) => a.index - b.index)) {
      const clusterX = clusterCount === 1 ? 0 : cluster.x * settings.clusterRadiusFactor;
      const clusterY = clusterCount === 1 ? 0 : cluster.y * settings.clusterRadiusFactor;
      const sorted = [...cluster.nodes].sort((a, b) => b.linkCount - a.linkCount);
      sorted.forEach((node, localIndex) => {
        const angle = localIndex * GOLDEN_ANGLE;
        const radius =
          Math.sqrt(localIndex + 1) * localGap * (1 + Math.sqrt(sorted.length) * 0.012);
        const degreePull = 1 / (1 + node.linkCount * 0.018);
        const jitter = (stableNoise(node.filePath) - 0.5) * localGap * 0.72;
        const tangentJitter = (stableNoise(`${node.filePath}:t`) - 0.5) * localGap * 0.48;
        const layoutNode = {
          ...node,
          x:
            clusterX +
            Math.cos(angle) * (radius * degreePull + jitter) -
            Math.sin(angle) * tangentJitter,
          y:
            clusterY +
            Math.sin(angle) * (radius * degreePull + jitter) +
            Math.cos(angle) * tangentJitter,
          vx: 0,
          vy: 0,
          homeX:
            clusterX +
            Math.cos(angle) * (radius * degreePull + jitter) -
            Math.sin(angle) * tangentJitter,
          homeY:
            clusterY +
            Math.sin(angle) * (radius * degreePull + jitter) +
            Math.cos(angle) * tangentJitter,
        };
        layoutNodes.push(layoutNode);
        nodeByPath.set(node.filePath, layoutNode);
      });
    }

    currentLayout = {
      nodes: layoutNodes,
      links: links
        .map((link) => {
          const source = nodeByPath.get(link.source);
          const target = nodeByPath.get(link.target);
          return source && target ? { source, target } : null;
        })
        .filter((link): link is LayoutLink => link !== null),
    };
    redrawLinksOnNextDraw = true;
    redrawClustersOnNextDraw = true;
    startLayoutRelaxation(isHugeGraph() ? 72 : 110);
  }

  function graphToScreen(x: number, y: number): { x: number; y: number } {
    return { x: x * view.scale + view.x, y: y * view.scale + view.y };
  }

  function screenToGraph(x: number, y: number): { x: number; y: number } {
    return { x: (x - view.x) / view.scale, y: (y - view.y) / view.scale };
  }

  function visibleBounds(margin = 96): { minX: number; maxX: number; minY: number; maxY: number } {
    const { width, height } = dimensions();
    const topLeft = screenToGraph(-margin, -margin);
    const bottomRight = screenToGraph(width + margin, height + margin);
    return {
      minX: Math.min(topLeft.x, bottomRight.x),
      maxX: Math.max(topLeft.x, bottomRight.x),
      minY: Math.min(topLeft.y, bottomRight.y),
      maxY: Math.max(topLeft.y, bottomRight.y),
    };
  }

  function linkVisible(link: LayoutLink): boolean {
    if (isLinkFocusLink(link)) return true;
    if (renderBudget() !== "huge") return true;
    if (!hasExplicitLinkFocus() && !hoverFadeActive()) return true;
    const key =
      link.source.filePath < link.target.filePath
        ? `${link.source.filePath}\n${link.target.filePath}`
        : `${link.target.filePath}\n${link.source.filePath}`;
    return stableHash(key) % (hoverFadeActive() ? 8 : 2) === 0;
  }

  function syncWorldTransform(): void {
    if (!world) return;
    world.position.set(view.x, view.y);
    world.scale.set(view.scale);
    setZoomLevel(view.scale);
  }

  function requestDraw(options: DrawOptions = {}): void {
    redrawLinksOnNextDraw ||= options.links ?? false;
    redrawClustersOnNextDraw ||= options.clusters ?? false;
    if (renderFrame !== undefined) return;
    renderFrame = requestAnimationFrame(() => {
      renderFrame = undefined;
      draw();
    });
  }

  function cancelLayoutRelaxation(): void {
    if (layoutRelaxFrame === undefined) return;
    cancelAnimationFrame(layoutRelaxFrame);
    layoutRelaxFrame = undefined;
  }

  function startLayoutRelaxation(ticks: number): void {
    cancelLayoutRelaxation();
    layoutRelaxTicks = Math.min(ticks, getGraphSettings().cooldownTicks);
    layoutRelaxCooling = 1;
    layoutRelaxDrawTick = 0;
    const step = () => {
      layoutRelaxFrame = undefined;
      if (destroyed || layoutRelaxTicks <= 0) return;
      const maxSpeed = relaxLayoutStep(selectedLayoutNode(), layoutRelaxCooling);
      layoutRelaxTicks -= 1;
      layoutRelaxCooling *= Math.max(0.9, 1 - getGraphSettings().alphaDecay * 3.5);
      layoutRelaxDrawTick += 1;
      let redrawStructuralLayers = true;
      if (renderBudget() === "huge") {
        redrawStructuralLayers = layoutRelaxDrawTick % 4 === 0 || layoutRelaxTicks <= 1;
      } else if (isLargeGraph()) {
        redrawStructuralLayers = layoutRelaxDrawTick % 2 === 0 || layoutRelaxTicks <= 1;
      }
      requestDraw({ links: redrawStructuralLayers, clusters: redrawStructuralLayers });
      if (layoutRelaxTicks > 0 && (layoutRelaxCooling > 0.006 || maxSpeed > 0.008)) {
        layoutRelaxFrame = requestAnimationFrame(step);
      }
    };
    layoutRelaxFrame = requestAnimationFrame(step);
  }

  function shouldRelaxLink(link: LayoutLink): boolean {
    if (isFocusedLink(link)) return true;
    if (isHugeGraph()) {
      const key =
        link.source.filePath < link.target.filePath
          ? `${link.source.filePath}\n${link.target.filePath}`
          : `${link.target.filePath}\n${link.source.filePath}`;
      return stableHash(key) % 18 === 0;
    }
    if (isLargeGraph()) {
      const key =
        link.source.filePath < link.target.filePath
          ? `${link.source.filePath}\n${link.target.filePath}`
          : `${link.target.filePath}\n${link.source.filePath}`;
      return stableHash(key) % 8 === 0;
    }
    return true;
  }

  function relaxLayoutStep(pinnedNode?: LayoutNode, cooling = 1): number {
    const settings = getGraphSettings();
    const repulsionRadius = graphNodePairRepulsionRadius(settings, renderBudget(), false, false);
    const cellSize = Math.max(20, settings.nodeMaxSize * 2.8 + 8, repulsionRadius);
    const grid = new Map<string, LayoutNode[]>();

    for (const node of currentLayout.nodes) {
      if (node !== pinnedNode) {
        node.vx += (node.homeX - node.x) * 0.0065 * cooling;
        node.vy += (node.homeY - node.y) * 0.0065 * cooling;
      }
      const cellX = Math.floor(node.x / cellSize);
      const cellY = Math.floor(node.y / cellSize);
      const key = `${cellX}:${cellY}`;
      const list = grid.get(key) ?? [];
      list.push(node);
      grid.set(key, list);
    }

    for (const node of currentLayout.nodes) {
      const cellX = Math.floor(node.x / cellSize);
      const cellY = Math.floor(node.y / cellSize);
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const list = grid.get(`${cellX + ox}:${cellY + oy}`);
          if (!list) continue;
          for (const other of list) {
            if (node.filePath >= other.filePath) continue;
            let dx = other.x - node.x;
            let dy = other.y - node.y;
            let dist = Math.hypot(dx, dy);
            if (dist < 0.001) {
              dx = stableNoise(`${node.filePath}:${other.filePath}:x`) - 0.5;
              dy = stableNoise(`${node.filePath}:${other.filePath}:y`) - 0.5;
              dist = Math.hypot(dx, dy) || 1;
            }
            const minDist = nodeRadius(node, isCompact()) + nodeRadius(other, isCompact()) + 3.5;
            const spacingRadius = graphNodePairRepulsionRadius(
              settings,
              renderBudget(),
              node.isOrphan,
              other.isOrphan,
            );
            const targetDist = Math.max(minDist, spacingRadius);
            if (dist >= targetDist) continue;
            const collisionPush = Math.max(0, minDist - dist) * 0.072;
            const spacingPush =
              Math.max(0, targetDist - dist) *
              graphNodePairRepulsionStrength(settings, node.isOrphan, other.isOrphan);
            const push = (collisionPush + spacingPush) * cooling;
            const nx = dx / dist;
            const ny = dy / dist;
            if (node !== pinnedNode) {
              node.vx -= nx * push;
              node.vy -= ny * push;
            }
            if (other !== pinnedNode) {
              other.vx += nx * push;
              other.vy += ny * push;
            }
          }
        }
      }
    }

    for (const link of currentLayout.links) {
      if (!shouldRelaxLink(link)) continue;
      const dx = link.target.x - link.source.x;
      const dy = link.target.y - link.source.y;
      const dist = Math.hypot(dx, dy) || 1;
      const target = settings.linkDistance;
      const strength = (isFocusedLink(link) ? 0.0028 : 0.00115) * settings.linkStrength * cooling;
      const pull = (dist - target) * strength;
      const nx = dx / dist;
      const ny = dy / dist;
      if (link.source !== pinnedNode) {
        link.source.vx += nx * pull;
        link.source.vy += ny * pull;
      }
      if (link.target !== pinnedNode) {
        link.target.vx -= nx * pull;
        link.target.vy -= ny * pull;
      }
    }

    let maxSpeed = 0;
    const damping =
      Math.max(0.62, Math.min(0.9, 1 - settings.velocityDecay * 0.48)) -
      Math.min(0.08, (1 - cooling) * 0.08);
    for (const node of currentLayout.nodes) {
      if (node === pinnedNode) {
        node.vx = 0;
        node.vy = 0;
        continue;
      }
      node.vx *= damping;
      node.vy *= damping;
      node.x += Math.max(-6, Math.min(6, node.vx));
      node.y += Math.max(-6, Math.min(6, node.vy));
      maxSpeed = Math.max(maxSpeed, Math.hypot(node.vx, node.vy));
    }
    return maxSpeed;
  }

  function drawClusterLabel(clusterIndex: number, points: { x: number; y: number }[]): void {
    if (isCompact() || view.scale >= 1.5 || !labelLayer || points.length === 0) return;
    const cx = points.reduce((sum, point) => sum + point.x, 0) / points.length;
    const minY = Math.min(...points.map((point) => point.y));
    const clusterName = graphState()?.clusters[clusterIndex] || t("graph.cluster.root") || "Root";
    addTextPill({
      text: shortLabel(clusterName.split("/").pop() ?? clusterName, 14),
      x: cx,
      y: minY - 22 / Math.max(view.scale, 1),
      fill: clusterTextColor(clusterIndex, cssVar("--color-graph-cluster-text-l", "72%")),
      fontSize: 11,
      fontWeight: "600",
      anchorX: 0.5,
      anchorY: 0.5,
      alpha: 0.92,
    });
  }

  function clusterLabelGroups(): Map<number, { x: number; y: number }[]> {
    const groups = new Map<number, { x: number; y: number }[]>();
    if (!showClusters() || isCompact() || view.scale >= 1.5) return groups;
    const bounds = visibleBounds();
    for (const node of currentLayout.nodes) {
      const visible =
        node.x >= bounds.minX &&
        node.x <= bounds.maxX &&
        node.y >= bounds.minY &&
        node.y <= bounds.maxY;
      if (renderBudget() === "huge" && !visible && !isNeighborhoodNode(node)) continue;
      const list = groups.get(node.clusterIndex) ?? [];
      list.push({ x: node.x, y: node.y });
      groups.set(node.clusterIndex, list);
    }
    return groups;
  }

  function drawClusterLabels(): void {
    for (const [clusterIndex, points] of clusterLabelGroups()) {
      let budget = points.length;
      if (renderBudget() === "huge") budget = 96;
      else if (renderBudget() === "large") budget = 160;
      const sampled =
        points.length > budget
          ? points.filter((_, i) => i % Math.ceil(points.length / budget) === 0)
          : points;
      drawClusterLabel(clusterIndex, sampled);
    }
  }

  function drawClusters(): void {
    if (!clusterLayer || !showClusters()) return;
    const hoveredClusterIndex = hoverFadeActive() ? hoveredNode()?.clusterIndex : undefined;
    const groups = new Map<number, LayoutNode[]>();
    const bounds = visibleBounds();
    for (const node of currentLayout.nodes) {
      const visible =
        node.x >= bounds.minX &&
        node.x <= bounds.maxX &&
        node.y >= bounds.minY &&
        node.y <= bounds.maxY;
      if (renderBudget() === "huge" && !visible && !isNeighborhoodNode(node)) continue;
      const list = groups.get(node.clusterIndex) ?? [];
      list.push(node);
      groups.set(node.clusterIndex, list);
    }

    const padding = getGraphSettings().clusterPadding;
    for (const [clusterIndex, nodes] of groups) {
      if (nodes.length === 0) continue;
      let budget = nodes.length;
      if (renderBudget() === "huge") budget = 96;
      else if (renderBudget() === "large") budget = 160;
      const sampled =
        nodes.length > budget
          ? nodes.filter((_, i) => i % Math.ceil(nodes.length / budget) === 0)
          : nodes;
      const points = sampled.map((node) => ({ x: node.x, y: node.y }));
      const fillAlpha =
        budgetNumber(renderBudget(), {
          normal: 0.12,
          dense: 0.1,
          large: 0.34,
          huge: 0.26,
        }) * (hoveredClusterIndex !== undefined && hoveredClusterIndex !== clusterIndex ? 0.62 : 1);
      const strokeAlpha =
        budgetNumber(renderBudget(), {
          normal: 0.24,
          dense: 0.18,
          large: 0.16,
          huge: 0.12,
        }) * (hoveredClusterIndex !== undefined && hoveredClusterIndex !== clusterIndex ? 0.5 : 1);

      if (points.length === 1) {
        clusterLayer.circle(points[0].x, points[0].y, padding).fill({
          color: clusterBgColor(clusterIndex),
          alpha: fillAlpha,
        });
      } else if (points.length === 2) {
        const cx = (points[0].x + points[1].x) / 2;
        const cy = (points[0].y + points[1].y) / 2;
        const dist = Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y);
        clusterLayer.ellipse(cx, cy, dist / 2 + padding, padding).fill({
          color: clusterBgColor(clusterIndex),
          alpha: fillAlpha,
        });
      } else {
        const hull = expandHull(convexHull(points), padding);
        if (hull.length < 3) continue;
        clusterLayer.moveTo(hull[0].x, hull[0].y);
        for (let i = 1; i < hull.length; i++) clusterLayer.lineTo(hull[i].x, hull[i].y);
        clusterLayer.closePath().fill({ color: clusterBgColor(clusterIndex), alpha: fillAlpha });
        clusterLayer.stroke({
          color: clusterColor(clusterIndex),
          alpha: strokeAlpha,
          width: 1.1 / view.scale,
        });
      }

      drawClusterLabel(clusterIndex, points);
    }
  }

  function linkColor(link: LayoutLink): { color: number | string; alpha: number } {
    const theme = getEffectiveTheme();
    const sourceId = link.source.filePath;
    const targetId = link.target.filePath;
    const focus = linkFocusFilePath();
    const focused = Boolean(focus && (sourceId === focus || targetId === focus));
    const fadeHover = hoverFadeActive();

    if (focus) {
      if (!focused) {
        return {
          color: defaultLinkColor(theme),
          alpha: alphaWithSetting(fadeHover ? 0.18 : 0.34),
        };
      }

      return { color: clusterColor(link.source.clusterIndex), alpha: alphaWithSetting(0.92) };
    }

    if (isDenseGraph()) {
      let alpha = 0.42;
      if (isHugeGraph()) alpha = 0.38;
      else if (isLargeGraph()) alpha = 0.4;

      return {
        color: defaultLinkColor(theme),
        alpha: alphaWithSetting(alpha),
      };
    }

    const selected = selectedNode();
    if (selected && (sourceId === selected || targetId === selected)) {
      return {
        color: cssVar("--color-graph-link-selected", "#7ab0df"),
        alpha: alphaWithSetting(0.75),
      };
    }

    const current = currentFilePath();
    if (current && (sourceId === current || targetId === current)) {
      return {
        color: cssVar("--color-graph-link-current", "#8b5cf6"),
        alpha: alphaWithSetting(0.75),
      };
    }

    const hovered = hoveredNode();
    if (hovered && (sourceId === hovered.filePath || targetId === hovered.filePath)) {
      return { color: clusterColor(link.source.clusterIndex), alpha: alphaWithSetting(0.63) };
    }

    return {
      color: defaultLinkColor(theme),
      alpha: alphaWithSetting(0.46),
    };
  }

  function linkWidth(link: LayoutLink): number {
    const scale = getGraphSettings().linkWidthScale;
    if (isLinkFocusLink(link)) return 2.4 * scale;
    if (isHighlightedLink(link)) return 1.35 * scale;
    if (isHugeGraph()) return 0.46 * scale;
    if (isLargeGraph()) return 0.52 * scale;
    if (isDenseGraph()) return 0.58 * scale;
    if (linkFocusFilePath()) return 0.32 * scale;
    return 0.95 * scale;
  }

  function linkArrowLength(link: LayoutLink): number {
    if (!getGraphSettings().showArrows) return 0;
    if (isDenseGraph() && !isLinkFocusLink(link)) return 0;
    return getGraphSettings().arrowLength;
  }

  function linkCurvature(link: LayoutLink): number {
    if (isDenseGraph() && !isLinkFocusLink(link)) return 0;
    return getGraphSettings().linkCurvature;
  }

  function drawLinkPath(
    link: LayoutLink,
    width: number,
    color: number | string,
    alpha: number,
  ): void {
    if (!linkLayer) return;
    const curvature = linkCurvature(link);
    const sx = link.source.x;
    const sy = link.source.y;
    const tx = link.target.x;
    const ty = link.target.y;
    let endAngle = Math.atan2(ty - sy, tx - sx);

    linkLayer.moveTo(sx, sy);
    if (curvature === 0) {
      linkLayer.lineTo(tx, ty);
    } else {
      const mx = (sx + tx) / 2;
      const my = (sy + ty) / 2;
      const dx = tx - sx;
      const dy = ty - sy;
      const dist = Math.hypot(dx, dy) || 1;
      const cx = mx + (-dy / dist) * dist * curvature;
      const cy = my + (dx / dist) * dist * curvature;
      endAngle = Math.atan2(ty - cy, tx - cx);
      linkLayer.quadraticCurveTo(cx, cy, tx, ty);
    }
    linkLayer.stroke({ color, alpha, width: width / view.scale });

    const arrow = linkArrowLength(link);
    if (arrow <= 0) return;
    const targetRadius = nodeRadius(link.target, isCompact()) + 1.5 / view.scale;
    const arrowSize = arrow / view.scale;
    const tipX = tx - Math.cos(endAngle) * targetRadius;
    const tipY = ty - Math.sin(endAngle) * targetRadius;
    const left = endAngle + Math.PI * 0.82;
    const right = endAngle - Math.PI * 0.82;
    linkLayer
      .moveTo(tipX, tipY)
      .lineTo(tipX + Math.cos(left) * arrowSize, tipY + Math.sin(left) * arrowSize)
      .lineTo(tipX + Math.cos(right) * arrowSize, tipY + Math.sin(right) * arrowSize)
      .closePath()
      .fill({ color, alpha: Math.min(0.85, alpha + 0.12) });
  }

  function drawLinks(): void {
    if (!linkLayer) return;
    const bounds = visibleBounds(160);

    for (const link of currentLayout.links) {
      if (!linkVisible(link)) continue;
      const sourceVisible =
        link.source.x >= bounds.minX &&
        link.source.x <= bounds.maxX &&
        link.source.y >= bounds.minY &&
        link.source.y <= bounds.maxY;
      const targetVisible =
        link.target.x >= bounds.minX &&
        link.target.x <= bounds.maxX &&
        link.target.y >= bounds.minY &&
        link.target.y <= bounds.maxY;
      if (renderBudget() === "huge" && !sourceVisible && !targetVisible && !isLinkFocusLink(link)) {
        continue;
      }
      const { color, alpha: baseAlpha } = linkColor(link);
      const alpha = isLinkFocusLink(link) ? Math.max(baseAlpha, 0.78) : baseAlpha;
      drawLinkPath(link, linkWidth(link), color, alpha);
    }
  }

  function addTextPill(options: {
    text: string;
    x: number;
    y: number;
    fill: string | number;
    fontSize: number;
    fontWeight: "500" | "600";
    anchorX: number;
    anchorY: number;
    alpha?: number;
  }): void {
    if (!labelLayer) return;
    const screenPoint = graphToScreen(options.x, options.y);
    const text = new Text({
      text: options.text,
      style: {
        fill: options.fill,
        fontFamily: labelFontFamily(),
        fontSize: options.fontSize,
        fontWeight: options.fontWeight,
      },
    });
    text.anchor.set(options.anchorX, options.anchorY);
    text.position.set(screenPoint.x, screenPoint.y);
    text.resolution = pixiResolution();

    const bounds = text.getLocalBounds();
    const padX = 4;
    const padY = 3;
    const bg = new Graphics();
    bg.roundRect(
      screenPoint.x - bounds.width * options.anchorX - padX,
      screenPoint.y - bounds.height * options.anchorY - padY,
      bounds.width + padX * 2,
      bounds.height + padY * 2,
      2,
    ).fill({
      color: cssVar("--color-bg-secondary", getEffectiveTheme() === "dark" ? "#171717" : "#ffffff"),
      alpha: options.alpha ?? 0.82,
    });
    labelLayer.addChild(bg, text);
  }

  function drawNodes(): void {
    if (!nodeLayer || !labelLayer) return;
    const bounds = visibleBounds();
    for (const node of currentLayout.nodes) {
      const visible =
        node.x >= bounds.minX &&
        node.x <= bounds.maxX &&
        node.y >= bounds.minY &&
        node.y <= bounds.maxY;
      const neighborhood = isNeighborhoodNode(node);
      const highlighted = isHighlightedNode(node);
      const softHighlighted = isSoftHighlightedNode(node);
      if (renderBudget() === "huge" && !visible && !softHighlighted) continue;

      const selected = node.filePath === selectedNode();
      const current = node.filePath === currentFilePath();
      const hovered = node.filePath === hoveredNode()?.filePath;
      const cheapBackground = isDenseGraph() && !softHighlighted;
      const baseRadius = nodeRadius(node, isCompact());
      let radius = baseRadius;
      if (selected || hovered) radius = baseRadius * 1.3;
      else if (softHighlighted) radius = baseRadius * 1.15;

      let color = clusterColor(node.clusterIndex);
      if (node.isOrphan) {
        color = cssVar("--color-graph-node-orphan", "#727780");
      } else if (selected) {
        color = cssVar(
          "--color-graph-node-selected",
          getEffectiveTheme() === "dark" ? "#f4f4f0" : "#d6246f",
        );
      } else if (current) {
        color = cssVar("--color-graph-node-current", "#8b5cf6");
      }

      if (cheapBackground) {
        const backgroundScale = budgetNumber(renderBudget(), {
          normal: 0.82,
          dense: 0.82,
          large: 0.72,
          huge: 0.58,
        });
        const backgroundAlpha = budgetNumber(renderBudget(), {
          normal: 1,
          dense: 1,
          large: 1,
          huge: 1,
        });
        nodeLayer.circle(node.x, node.y, Math.max(1.5, baseRadius * backgroundScale)).fill({
          color,
          alpha:
            hoverFadeActive() && !softHighlighted
              ? getGraphSettings().hoverFadeOpacity
              : backgroundAlpha,
        });
        continue;
      }

      if (highlighted || softHighlighted) {
        let highlightAlpha = 0.19;
        if (selected) {
          if (getEffectiveTheme() !== "dark") highlightAlpha = 0.11;
        } else if (softHighlighted && !hovered) {
          highlightAlpha = 0.27;
        }

        nodeLayer.circle(node.x, node.y, radius + 3.5 / view.scale).fill({
          color,
          alpha: highlightAlpha,
        });
      }

      const nodeAlpha =
        hoverFadeActive() && !softHighlighted ? getGraphSettings().hoverFadeOpacity : 1;
      nodeLayer.circle(node.x, node.y, radius).fill({ color, alpha: nodeAlpha });
      if (highlighted || softHighlighted) {
        nodeLayer.circle(node.x, node.y, radius + 2.8 / view.scale).stroke({
          color:
            selected || current
              ? cssVar("--color-graph-node-stroke-strong", "#d4d4d4")
              : cssVar("--color-graph-node-stroke-soft", "#d4d4d4"),
          alpha: selected ? 0.9 : 0.45,
          width: (selected ? 2 : 1.15) / view.scale,
        });
      }

      const labelThreshold = getGraphSettings().labelVisibilityThreshold;
      const showLabel =
        selected ||
        current ||
        hovered ||
        (neighborhood &&
          !isCompact() &&
          (renderBudget() === "normal" ||
            view.scale > labelThreshold + 0.3 ||
            node.linkCount >= 8)) ||
        (neighborhood && isCompact() && (selected || current || hovered)) ||
        (renderBudget() === "normal" && view.scale > labelThreshold);
      if (showLabel) {
        let maxLabelLength = 12;
        if (selected || current) maxLabelLength = 18;
        else if (view.scale > 2) maxLabelLength = 14;

        addTextPill({
          text: shortLabel(node.name, maxLabelLength),
          x: node.x,
          y: node.y + radius + 8 / Math.max(view.scale, 1),
          fill: clusterTextColor(node.clusterIndex, cssVar("--color-graph-cluster-text-l", "72%")),
          fontSize: selected || current ? 12 : 10.5,
          fontWeight: neighborhood ? "600" : "500",
          anchorX: 0.5,
          anchorY: 0,
          alpha: selected || current || hovered ? 0.92 : 0.76,
        });
      }
    }
  }

  function draw(): void {
    if (!clusterLayer || !linkLayer || !nodeLayer || !labelLayer) return;
    nodeLayer.clear();
    labelLayer.removeChildren().forEach((child) => child.destroy());
    syncWorldTransform();
    let redrewClusters = false;
    if (redrawClustersOnNextDraw || !showClusters()) {
      clusterLayer.clear();
      if (showClusters()) {
        drawClusters();
        redrewClusters = true;
      }
      redrawClustersOnNextDraw = false;
    }
    if (showClusters() && !redrewClusters) drawClusterLabels();
    if (redrawLinksOnNextDraw) {
      linkLayer.clear();
      drawLinks();
      redrawLinksOnNextDraw = false;
    }
    drawNodes();
  }

  function fitView(duration = 0): void {
    const { width, height } = dimensions();
    if (currentLayout.nodes.length === 0 || width <= 0 || height <= 0) return;
    const xs = currentLayout.nodes.map((node) => node.x);
    const ys = currentLayout.nodes.map((node) => node.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const graphWidth = Math.max(1, maxX - minX);
    const graphHeight = Math.max(1, maxY - minY);
    const padding = isCompact() ? Math.min(120, Math.max(72, Math.min(width, height) * 0.14)) : 96;
    const usableWidth = Math.max(1, width - padding);
    const usableHeight = Math.max(1, height - padding);
    const scale = Math.max(
      0.08,
      Math.min(4, Math.min(usableWidth / graphWidth, usableHeight / graphHeight)),
    );
    const nextView = {
      scale,
      x: width / 2 - ((minX + maxX) / 2) * scale,
      y: height / 2 - ((minY + maxY) / 2) * scale,
    };
    if (duration > 0) animateView(nextView, duration);
    else {
      cancelViewAnimation();
      view = nextView;
      requestDraw({ links: true, clusters: true });
    }
  }

  function cancelViewAnimation(): void {
    if (viewAnimationFrame === undefined) return;
    cancelAnimationFrame(viewAnimationFrame);
    viewAnimationFrame = undefined;
  }

  function cancelViewInertia(): void {
    if (viewInertiaFrame === undefined) return;
    cancelAnimationFrame(viewInertiaFrame);
    viewInertiaFrame = undefined;
  }

  function animateView(nextView: ViewState, duration = 850): void {
    cancelViewAnimation();
    cancelViewInertia();
    const start = { ...view };
    const startedAt = performance.now();
    const step = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / duration);
      const eased = easeInOutCubic(progress);
      view = {
        x: start.x + (nextView.x - start.x) * eased,
        y: start.y + (nextView.y - start.y) * eased,
        scale: start.scale + (nextView.scale - start.scale) * eased,
      };
      requestDraw({ links: true, clusters: true });
      if (progress < 1) {
        viewAnimationFrame = requestAnimationFrame(step);
      } else {
        viewAnimationFrame = undefined;
        view = nextView;
        requestDraw({ links: true, clusters: true });
      }
    };
    viewAnimationFrame = requestAnimationFrame(step);
  }

  function startViewInertia(velocityX: number, velocityY: number): void {
    cancelViewInertia();
    if (Math.hypot(velocityX, velocityY) < 0.018) return;

    let vx = velocityX;
    let vy = velocityY;
    let lastAt = performance.now();
    const startedAt = lastAt;

    const step = (now: number) => {
      viewInertiaFrame = undefined;
      if (destroyed) return;

      const dt = Math.min(34, now - lastAt);
      lastAt = now;
      view.x += vx * dt;
      view.y += vy * dt;

      const decay = Math.exp(-dt / 260);
      vx *= decay;
      vy *= decay;
      requestDraw();

      if (now - startedAt < 900 && Math.hypot(vx, vy) > 0.01) {
        viewInertiaFrame = requestAnimationFrame(step);
      }
    };

    viewInertiaFrame = requestAnimationFrame(step);
  }

  function followCurrentFile(): void {
    const next = !followMode();
    setFollowMode(next);
    if (next) {
      const fp = currentFilePath();
      if (fp) locateNode(fp);
    }
  }

  function focusScale(): number {
    if (isCompact()) return 1.6;
    if (isHugeGraph()) return 1.35;
    if (isLargeGraph()) return 1.55;
    return 1.9;
  }

  function zoomAt(centerX: number, centerY: number, nextScale: number, duration = 220): void {
    cancelViewAnimation();
    cancelViewInertia();
    const before = screenToGraph(centerX, centerY);
    const scale = Math.max(0.08, Math.min(8, nextScale));
    const nextView = {
      scale,
      x: centerX - before.x * scale,
      y: centerY - before.y * scale,
    };
    if (duration <= 0) {
      view = nextView;
      requestDraw({ links: true, clusters: true });
      return;
    }

    const start = { ...view };
    const startedAt = performance.now();
    const step = (now: number) => {
      viewAnimationFrame = undefined;
      if (destroyed) return;
      const progress = Math.min(1, (now - startedAt) / duration);
      const eased = easeOutCubic(progress);
      view = {
        x: start.x + (nextView.x - start.x) * eased,
        y: start.y + (nextView.y - start.y) * eased,
        scale: start.scale + (nextView.scale - start.scale) * eased,
      };
      requestDraw({ links: true, clusters: true });
      if (progress < 1) {
        viewAnimationFrame = requestAnimationFrame(step);
      } else {
        view = nextView;
        requestDraw({ links: true, clusters: true });
      }
    };
    viewAnimationFrame = requestAnimationFrame(step);
  }

  function zoomIn(): void {
    const { width, height } = dimensions();
    zoomAt(width / 2, height / 2, view.scale * 1.3, 280);
  }

  function zoomOut(): void {
    const { width, height } = dimensions();
    zoomAt(width / 2, height / 2, view.scale / 1.3, 280);
  }

  function resetView(): void {
    fitView(650);
  }

  function locateNode(filePath: string): void {
    const node = currentLayout.nodes.find((item) => item.filePath === filePath);
    if (!node) return;
    const { width, height } = dimensions();
    const scale = focusScale();
    setSelectedNode(filePath);
    pinFocusNode(filePath);
    animateView(
      {
        scale,
        x: width / 2 - node.x * scale,
        y: height / 2 - node.y * scale,
      },
      isCompact() ? 720 : 900,
    );
  }

  function nearestNode(clientX: number, clientY: number): LayoutNode | null {
    if (!hostEl) return null;
    const rect = hostEl.getBoundingClientRect();
    const point = screenToGraph(clientX - rect.left, clientY - rect.top);
    let best: LayoutNode | null = null;
    let bestDist = Number.POSITIVE_INFINITY;
    const threshold = Math.max(9 / view.scale, 5);
    for (const node of currentLayout.nodes) {
      const dist = Math.hypot(node.x - point.x, node.y - point.y);
      if (dist < bestDist && dist <= threshold + nodeRadius(node, isCompact())) {
        best = node;
        bestDist = dist;
      }
    }
    return best;
  }

  function applyDragInfluence(dragged: LayoutNode, deltaX: number, deltaY: number): void {
    if (Math.abs(deltaX) + Math.abs(deltaY) < 0.001) return;

    const directNeighbors = new Set<LayoutNode>();
    for (const link of currentLayout.links) {
      let neighbor: LayoutNode | null = null;
      if (link.source === dragged) neighbor = link.target;
      else if (link.target === dragged) neighbor = link.source;
      if (!neighbor) continue;

      directNeighbors.add(neighbor);
      const sameFolder = neighbor.folder === dragged.folder;
      const strength = sameFolder ? 0.42 : 0.32;
      neighbor.vx += deltaX * strength;
      neighbor.vy += deltaY * strength;
    }

    const radius = budgetNumber(renderBudget(), {
      normal: 240,
      dense: 210,
      large: 170,
      huge: 135,
    });
    const radiusSq = radius * radius;
    for (const node of currentLayout.nodes) {
      if (node === dragged || directNeighbors.has(node)) continue;
      const dx = node.x - dragged.x;
      const dy = node.y - dragged.y;
      const distSq = dx * dx + dy * dy;
      if (distSq > radiusSq) continue;
      const influence =
        (1 - distSq / radiusSq) * (node.clusterIndex === dragged.clusterIndex ? 0.18 : 0.08);
      node.vx += deltaX * influence;
      node.vy += deltaY * influence;
    }
  }

  function handlePointerMove(event: PointerEvent): void {
    if (!hostEl) return;
    if (nodeDrag) {
      const dx = (event.clientX - nodeDrag.startClientX) / view.scale;
      const dy = (event.clientY - nodeDrag.startClientY) / view.scale;
      const nextX = nodeDrag.startNodeX + dx;
      const nextY = nodeDrag.startNodeY + dy;
      const deltaX = nextX - nodeDrag.lastNodeX;
      const deltaY = nextY - nodeDrag.lastNodeY;
      nodeDrag.distance = Math.hypot(
        event.clientX - nodeDrag.startClientX,
        event.clientY - nodeDrag.startClientY,
      );
      nodeDrag.node.x = nextX;
      nodeDrag.node.y = nextY;
      nodeDrag.lastNodeX = nextX;
      nodeDrag.lastNodeY = nextY;
      applyDragInfluence(nodeDrag.node, deltaX, deltaY);
      relaxLayoutStep(nodeDrag.node);
      relaxLayoutStep(nodeDrag.node);
      requestDraw({ links: true, clusters: true });
      return;
    }
    if (dragStart) {
      const now = performance.now();
      const dt = Math.max(1, now - dragStart.lastAt);
      const instantVelocityX = (event.clientX - dragStart.lastX) / dt;
      const instantVelocityY = (event.clientY - dragStart.lastY) / dt;
      dragStart.velocityX = dragStart.velocityX * 0.58 + instantVelocityX * 0.42;
      dragStart.velocityY = dragStart.velocityY * 0.58 + instantVelocityY * 0.42;
      dragStart.lastX = event.clientX;
      dragStart.lastY = event.clientY;
      dragStart.lastAt = now;
      view.x = dragStart.view.x + event.clientX - dragStart.x;
      view.y = dragStart.view.y + event.clientY - dragStart.y;
      requestDraw();
      return;
    }
    if (hoverFrame !== undefined) return;
    hoverFrame = requestAnimationFrame(() => {
      hoverFrame = undefined;
      setHoveredNode(nearestNode(event.clientX, event.clientY));
    });
  }

  function handlePointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    cancelViewAnimation();
    cancelViewInertia();
    cancelLayoutRelaxation();
    const node = nearestNode(event.clientX, event.clientY);
    if (node) {
      nodeDrag = {
        node,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startNodeX: node.x,
        startNodeY: node.y,
        lastNodeX: node.x,
        lastNodeY: node.y,
        distance: 0,
      };
      hostEl?.setPointerCapture(event.pointerId);
      return;
    }
    dragStart = {
      x: event.clientX,
      y: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      lastAt: performance.now(),
      velocityX: 0,
      velocityY: 0,
      view: { ...view },
    };
    hostEl?.setPointerCapture(event.pointerId);
  }

  function handlePointerUp(event: PointerEvent): void {
    if (nodeDrag) {
      const dragged = nodeDrag;
      nodeDrag = null;
      hostEl?.releasePointerCapture(event.pointerId);
      if (dragged.distance > 5) {
        dragged.node.homeX = dragged.node.x;
        dragged.node.homeY = dragged.node.y;
        dragged.node.vx = 0;
        dragged.node.vy = 0;
        setSelectedNode(dragged.node.filePath);
        startLayoutRelaxation(isHugeGraph() ? 130 : 210);
        requestDraw({ links: true, clusters: true });
        return;
      }
      setSelectedNode(dragged.node.filePath);
      pinFocusNode(dragged.node.filePath);
      props.onNodeClick?.(dragged.node);
      return;
    }
    if (!dragStart) return;
    const pan = dragStart;
    const moved = Math.hypot(event.clientX - dragStart.x, event.clientY - dragStart.y);
    dragStart = null;
    hostEl?.releasePointerCapture(event.pointerId);
    if (moved > 5) {
      startViewInertia(pan.velocityX, pan.velocityY);
      return;
    }
    const node = nearestNode(event.clientX, event.clientY);
    if (node) {
      setSelectedNode(node.filePath);
      pinFocusNode(node.filePath);
      props.onNodeClick?.(node);
    } else {
      setSelectedNode(null);
      props.onBackgroundClick?.();
    }
  }

  function handleWheel(event: WheelEvent): void {
    event.preventDefault();
    if (!hostEl) return;
    const rect = hostEl.getBoundingClientRect();
    const delta = Math.max(-240, Math.min(240, normalizedWheelDelta(event)));
    const factor = Math.exp(-delta * 0.0018);
    zoomAt(event.clientX - rect.left, event.clientY - rect.top, view.scale * factor, 0);
  }

  function handleContextMenu(event: MouseEvent): void {
    const node = nearestNode(event.clientX, event.clientY);
    if (!node) return;
    event.preventDefault();
    setSelectedNode(node.filePath);
    pinFocusNode(node.filePath);
    props.onNodeRightClick?.(node);
  }

  function pixiResolution(): number {
    const ratio = window.devicePixelRatio || 1;
    if (renderBudget() === "normal") return Math.min(ratio, 2);
    if (isCompact()) return Math.min(ratio, 1.75);
    return Math.min(ratio, 1.5);
  }

  function resizePixi(width: number, height: number): void {
    if (!app) return;
    const nextWidth = Math.max(1, Math.floor(width));
    const nextHeight = Math.max(1, Math.floor(height));
    const resolution = pixiResolution();
    app.renderer.resolution = resolution;
    app.renderer.resize(nextWidth, nextHeight);
    app.canvas.style.width = `${nextWidth}px`;
    app.canvas.style.height = `${nextHeight}px`;
  }

  onMount(() => {
    if (!hostEl) return;

    void (async () => {
      try {
        const pixi = new Application();
        await pixi.init({
          antialias: true,
          autoDensity: true,
          backgroundAlpha: 0,
          powerPreference: "high-performance",
          resolution: pixiResolution(),
          resizeTo: hostEl,
        });
        pixi.canvas.style.position = "absolute";
        pixi.canvas.style.inset = "0";
        pixi.canvas.style.width = "100%";
        pixi.canvas.style.height = "100%";
        if (destroyed || !hostEl) {
          pixi.destroy(true);
          return;
        }

        app = pixi;
        world = new Container();
        clusterLayer = new Graphics();
        linkLayer = new Graphics();
        nodeLayer = new Graphics();
        labelLayer = new Container();
        world.addChild(clusterLayer, linkLayer, nodeLayer);
        pixi.stage.addChild(world);
        pixi.stage.addChild(labelLayer);
        hostEl.appendChild(pixi.canvas);

        const rect = hostEl.getBoundingClientRect();
        setDimensions({ width: rect.width, height: rect.height });
        resizePixi(rect.width, rect.height);
        hostEl.addEventListener("pointerdown", handlePointerDown);
        hostEl.addEventListener("pointermove", handlePointerMove);
        hostEl.addEventListener("pointerup", handlePointerUp);
        hostEl.addEventListener("pointerleave", handlePointerMove);
        hostEl.addEventListener("wheel", handleWheel, { passive: false });
        hostEl.addEventListener("contextmenu", handleContextMenu);

        resizeObs = new ResizeObserver((entries) => {
          for (const entry of entries) {
            const { width, height } = entry.contentRect;
            setDimensions({ width, height });
            resizePixi(width, height);
            fitView();
            requestDraw({ links: true, clusters: true });
          }
        });
        resizeObs.observe(hostEl);
        props.onHandle?.({ zoomIn, zoomOut, fitView, resetView, locateNode });
        requestDraw();
      } catch (error) {
        setInitError(error instanceof Error ? error.message : String(error));
      }
    })();
  });

  createEffect(
    on(
      () => layoutRevision(),
      () => {
        const s = graphState();
        if (!s || s.nodes.length === 0) return;
        buildLayout(s.nodes, s.links, s.clusters);
        const selected = selectedNode();
        if (selected) pinFocusNode(selected);
        fitView();
      },
    ),
  );

  createEffect(
    on(
      () => currentFilePath(),
      (filePath) => {
        if (filePath) {
          setSelectedNode(filePath);
          pinFocusNode(filePath);
        }
        if (followMode() && filePath) locateNode(filePath);
        requestDraw({ links: true, clusters: true });
      },
      { defer: true },
    ),
  );

  createEffect(
    on(
      () =>
        [
          hoveredNode(),
          selectedNode(),
          showClusters(),
          getEffectiveTheme(),
          settingsState.editor.fontFamily,
          currentLocale(),
        ] as const,
      () => requestDraw({ links: true, clusters: true }),
      { defer: true },
    ),
  );

  createEffect(
    on(
      () =>
        [
          getGraphSettings().linkOpacity,
          getGraphSettings().linkWidthScale,
          getGraphSettings().showArrows,
          getGraphSettings().labelVisibilityThreshold,
          getGraphSettings().hoverFadeOpacity,
          getGraphSettings().linkCurvature,
          getGraphSettings().arrowLength,
          getGraphSettings().clusterPadding,
        ] as const,
      () => requestDraw({ links: true, clusters: true }),
      { defer: true },
    ),
  );

  createEffect(() => {
    const settings = getGraphSettings();
    void [
      settings.chargeStrength,
      settings.chargeStrengthOrphan,
      settings.linkDistance,
      settings.centerStrength,
      settings.clusterStrength,
      settings.clusterRadiusFactor,
      settings.linkStrength,
      settings.alphaDecay,
      settings.velocityDecay,
      settings.warmupTicks,
      settings.cooldownTicks,
      settings.nodeSize,
      settings.nodeMinSize,
      settings.nodeMaxSize,
      settings.nodeSizeScale,
      settings.orphanNodeSize,
    ];

    const s = graphState();
    if (!s || s.nodes.length === 0) return;
    buildLayout(s.nodes, s.links, s.clusters);
    const selected = untrack(() => selectedNode());
    if (selected) pinFocusNode(selected);
    requestDraw({ links: true, clusters: true });
  });

  createEffect(
    on(
      () => graphAnimationReplayRevision(),
      () => {
        const s = graphState();
        if (!s || s.nodes.length === 0) return;
        buildLayout(s.nodes, s.links, s.clusters);
        const selected = untrack(() => selectedNode());
        if (selected) pinFocusNode(selected);
        requestDraw({ links: true, clusters: true });
      },
      { defer: true },
    ),
  );

  onCleanup(() => {
    destroyed = true;
    if (renderFrame !== undefined) cancelAnimationFrame(renderFrame);
    if (viewAnimationFrame !== undefined) cancelAnimationFrame(viewAnimationFrame);
    if (viewInertiaFrame !== undefined) cancelAnimationFrame(viewInertiaFrame);
    if (layoutRelaxFrame !== undefined) cancelAnimationFrame(layoutRelaxFrame);
    if (hoverFrame !== undefined) cancelAnimationFrame(hoverFrame);
    resizeObs?.disconnect();
    if (hostEl) {
      hostEl.removeEventListener("pointerdown", handlePointerDown);
      hostEl.removeEventListener("pointermove", handlePointerMove);
      hostEl.removeEventListener("pointerup", handlePointerUp);
      hostEl.removeEventListener("pointerleave", handlePointerMove);
      hostEl.removeEventListener("wheel", handleWheel);
      hostEl.removeEventListener("contextmenu", handleContextMenu);
    }
    app?.destroy(true);
  });

  return (
    <div
      class={`relative min-h-0 min-w-0 flex-1 overflow-hidden bg-bg-primary ${props.class ?? ""}`}
    >
      <div ref={hostEl} class="absolute inset-0 cursor-grab touch-none active:cursor-grabbing" />

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
                <p class="text-sm text-text-secondary">
                  {props.emptyTitle ?? t("graph.status.empty")}
                </p>
                <p class="text-xs text-text-muted">
                  {props.emptyHint ?? t("graph.status.empty_hint")}
                </p>
              </div>
            </Show>
            <div class="mt-4 flex items-center justify-center gap-3 text-[0.6875rem] text-text-muted">
              <span>{tf("graph.tab.metric.nodes", { count: summary().nodeCount })}</span>
              <span>{tf("graph.tab.metric.links", { count: summary().linkCount })}</span>
            </div>
          </div>
        </div>
      </Show>

      <Show when={status() === "ready"}>
        <div
          data-kuku-graph-canvas-controls="true"
          class="absolute top-32 right-3 flex w-10 flex-col items-center gap-1 rounded-xs border border-border/70 bg-bg-elevated/85 p-1 shadow-soft-2 backdrop-blur-sm"
          classList={{ "top-24! right-2! w-7! gap-0! p-0.5!": isCompact() }}
        >
          <CtrlBtn title={t("graph.ctrl.zoom_in")} onClick={zoomIn} compact={isCompact()}>
            <ZoomInIcon />
          </CtrlBtn>
          <CtrlBtn title={t("graph.ctrl.zoom_out")} onClick={zoomOut} compact={isCompact()}>
            <ZoomOutIcon />
          </CtrlBtn>
          <Show
            when={isCompact()}
            fallback={
              <CtrlBtn
                title={t("graph.ctrl.toggle_clusters")}
                onClick={() => {
                  updateGraphSetting("showClusters", !showClusters());
                  requestDraw({ clusters: true });
                }}
                active={showClusters()}
              >
                <ClustersIcon />
              </CtrlBtn>
            }
          >
            <CtrlBtn
              title={t("graph.ctrl.toggle_clusters")}
              onClick={() => {
                setCompactShowClusters(!compactShowClusters());
                requestDraw({ clusters: true });
              }}
              active={showClusters()}
              compact
            >
              <ClustersIcon />
            </CtrlBtn>
          </Show>
          <CtrlBtn
            title={t("graph.ctrl.fit_all")}
            onClick={() => fitView(650)}
            compact={isCompact()}
          >
            <FitViewIcon />
          </CtrlBtn>
          <Show when={isCompact() && showFollowControl()}>
            <CtrlBtn
              title={followMode() ? t("graph.ctrl.stop_following") : t("graph.ctrl.follow_current")}
              onClick={followCurrentFile}
              active={followMode()}
              compact
            >
              <LocateIcon />
            </CtrlBtn>
          </Show>
          <Show when={!isCompact()}>
            <Show when={showFollowControl()}>
              <CtrlBtn
                title={
                  followMode() ? t("graph.ctrl.stop_following") : t("graph.ctrl.follow_current")
                }
                onClick={followCurrentFile}
                active={followMode()}
              >
                <LocateIcon />
              </CtrlBtn>
            </Show>
            <CtrlBtn title={t("graph.ctrl.reset_view")} onClick={resetView}>
              <ResetViewIcon />
            </CtrlBtn>
          </Show>
          <Show when={showZoomLabel()}>
            <span
              class="flex h-6 w-8 items-center justify-center px-0 text-center font-mono text-[0.625rem] text-text-muted tabular-nums"
              classList={{
                "h-5 w-6 text-[0.5625rem]": isCompact(),
              }}
            >
              {Math.round(zoomLevel() * 100)}%
            </span>
          </Show>
        </div>
      </Show>
    </div>
  );
}

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
        "size-8": !props.compact,
        "size-6": props.compact,
        "bg-ghost-active! text-text-accent!": props.active,
      }}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}
