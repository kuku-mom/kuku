// ── Graph Canvas 3D ──
//
// Three.js-backed graph renderer for the full graph tab. It intentionally
// shares GraphStore and GraphCanvasHandle with the 2D canvas so the tab can
// switch renderers without changing graph indexing or navigation behavior.

import {
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
import ForceGraph3D, { type ConfigOptions, type ForceGraph3DInstance } from "3d-force-graph";
import SpriteText from "three-spritetext";
import { Group, Mesh, MeshPhysicalMaterial, SphereGeometry } from "three";

import { t, tf } from "~/i18n";
import { getEffectiveTheme } from "~/stores/theme";

import { graphAnimationReplayRevision } from "./graph_animation";
import { getGraphStore } from "./graph_store";
import { getGraphSettings } from "./graph_settings";
import {
  GRAPH_3D_SCROLL_ZOOM_SPEED,
  clusterColor,
  filterGraphState,
  getGraphSummary,
  hasGraphPointerTarget,
  type FGLink,
  type FGNode,
  type GraphCanvasHandle,
  type GraphNode,
  type GraphNodeFilter,
  type GraphVariant,
} from "./graph_types";

interface GraphCanvas3DProps {
  variant: GraphVariant;
  currentFilePath?: string | null;
  onNodeClick?: (node: GraphNode) => void;
  onBackgroundClick?: () => void;
  onHandle?: (handle: GraphCanvasHandle) => void;
  initialFollowMode?: boolean;
  nodeFilter?: GraphNodeFilter;
  preserveFilteredClusterColors?: boolean;
  class?: string;
}

type Graph3D = ForceGraph3DInstance<FGNode, FGLink>;
type Graph3DConstructor = new (element: HTMLElement, configOptions?: ConfigOptions) => Graph3D;
type RenderBudget = "normal" | "dense" | "large" | "huge";

interface CameraPoint {
  x: number;
  y: number;
  z: number;
}

const NODE_GEOMETRY = new SphereGeometry(1, 24, 16);
const GRAPH_3D_NODE_REL_SIZE = 1;
const Graph3DConstructor = ForceGraph3D as unknown as Graph3DConstructor;
const DENSE_GRAPH_NODE_COUNT = 500;
const LARGE_GRAPH_NODE_COUNT = 1_000;
const HUGE_GRAPH_NODE_COUNT = 1_500;
const DENSE_LINK_RATIO = 2.2;
const LARGE_LINK_RATIO = 3;
const HUGE_LINK_RATIO = 4;

interface NodeOpacityOptions {
  selected: boolean;
  highlighted: boolean;
  softHighlighted: boolean;
  hasFocus: boolean;
}

function easeOutQuart(progress: number): number {
  return 1 - (1 - progress) ** 4;
}

function lerpPoint(from: CameraPoint, to: CameraPoint, progress: number): CameraPoint {
  return {
    x: from.x + (to.x - from.x) * progress,
    y: from.y + (to.y - from.y) * progress,
    z: from.z + (to.z - from.z) * progress,
  };
}

function nodeOpacity(options: NodeOpacityOptions): number {
  const fadeOpacity = getGraphSettings("3d").hoverFadeOpacity;
  if (options.selected) return 1;
  if (options.highlighted) return 0.98;
  if (options.softHighlighted) return 0.88;
  if (options.hasFocus) return fadeOpacity;
  return 0.72;
}

function nodeScale(radius: number, highlighted: boolean, softHighlighted: boolean): number {
  if (highlighted) return radius;
  if (softHighlighted) return radius;
  return radius;
}

function isObjectNode(value: string | FGNode): value is FGNode {
  return typeof value === "object";
}

function nodeRadius(node: FGNode): number {
  const cfg = getGraphSettings("3d");
  if (node.isOrphan) return cfg.orphanNodeSize * 0.9 * cfg.nodeSize;
  return (
    Math.max(
      cfg.nodeMinSize,
      Math.min(cfg.nodeMaxSize, cfg.nodeMinSize + node.linkCount * cfg.nodeSizeScale),
    ) * cfg.nodeSize
  );
}

function nodeVisualRadius(node: FGNode): number {
  return Math.cbrt(Math.max(2, nodeRadius(node))) * GRAPH_3D_NODE_REL_SIZE;
}

function cameraDistanceForZoom(cameraPosition: { x: number; y: number; z: number }, scale: number) {
  return {
    x: cameraPosition.x * scale,
    y: cameraPosition.y * scale,
    z: cameraPosition.z * scale,
  };
}

function shortLabel(name: string): string {
  return name.length > 22 ? `${name.slice(0, 22)}…` : name;
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

export default function GraphCanvas3D(props: GraphCanvas3DProps) {
  let hostEl: HTMLDivElement | undefined;
  let graphEl: Graph3D | undefined;
  let resizeObs: ResizeObserver | undefined;
  let cameraAnimationFrame: number | undefined;
  let isCameraAnimating = false;
  let pendingHoveredNode: FGNode | null | undefined;
  let hoverFrame: number | undefined;
  let lastHugeHoverAt = 0;

  const cssVarCache = new Map<string, string>();

  /** Resolve theme tokens from the graph host (same pattern as 2D canvas). */
  function cssVar(name: string, fallback = ""): string {
    if (!hostEl) return fallback;
    const cached = cssVarCache.get(name);
    if (cached !== undefined) return cached;
    const value = getComputedStyle(hostEl).getPropertyValue(name).trim() || fallback;
    cssVarCache.set(name, value);
    return value;
  }

  const [initError, setInitError] = createSignal<string | null>(null);
  const [hoveredNode, setHoveredNode] = createSignal<FGNode | null>(null);
  const [selectedNode, setSelectedNode] = createSignal<string | null>(null);
  const [followMode, setFollowMode] = createSignal(props.initialFollowMode ?? false);
  const [zoomLevel, setZoomLevel] = createSignal(1);
  const [dimensions, setDimensions] = createSignal({ width: 400, height: 300 });

  const store = createMemo(() => getGraphStore());
  const isCompact = () => props.variant === "compact";
  const currentFilePath = () => props.currentFilePath ?? null;
  const graphState = createMemo(() => {
    const state = store()?.state;
    return state
      ? filterGraphState(state, props.nodeFilter, {
          preserveClusterIndices: props.preserveFilteredClusterColors,
        })
      : null;
  });

  const focusedFilePath = () => hoveredNode()?.filePath ?? selectedNode() ?? currentFilePath();

  const connectedToFocus = createMemo(() => {
    const fp = focusedFilePath();
    const s = graphState();
    if (!fp || !s) return new Set<string>();
    return new Set(s.adjacencyMap[fp]);
  });

  const status = createMemo((): "loading" | "error" | "empty" | "ready" => {
    const rawState = store()?.state;
    const s = graphState();
    if (!rawState || rawState.isIndexing) return "loading";
    if (rawState.error) return "error";
    if (!s || s.nodes.length === 0) return "empty";
    return "ready";
  });

  const summary = createMemo(() => getGraphSummary(graphState()));
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

  function nodeColor(node: FGNode): string {
    const theme = getEffectiveTheme();
    if (node.filePath === selectedNode()) {
      return cssVar("--color-graph-node-selected", theme === "dark" ? "#f4f4f0" : "#d6246f");
    }
    if (node.filePath === currentFilePath()) {
      return cssVar("--color-graph-node-current", theme === "dark" ? "#b794f6" : "#6842c2");
    }
    if (node.isOrphan) {
      return cssVar("--color-graph-node-orphan", theme === "dark" ? "#727780" : "#939aa5");
    }
    return clusterColor(node.clusterIndex);
  }

  function linkColor(link: FGLink): string {
    const theme = getEffectiveTheme();
    const sourceId = isObjectNode(link.source) ? link.source.filePath : link.source;
    const targetId = isObjectNode(link.target) ? link.target.filePath : link.target;
    const sourceNode = isObjectNode(link.source) ? link.source : null;
    const current = currentFilePath();
    const focus = focusedFilePath();

    if (focus) {
      if (sourceId !== focus && targetId !== focus) {
        return theme === "dark" ? "rgba(120,130,145,0.055)" : "rgba(56,62,72,0.055)";
      }

      if (sourceNode) return clusterColor(sourceNode.clusterIndex, 0.92);
      return theme === "dark" ? "rgba(242,244,255,0.78)" : "rgba(34,28,50,0.72)";
    }

    const selected = selectedNode();
    if (selected && (sourceId === selected || targetId === selected)) {
      return cssVar(
        "--color-graph-link-selected",
        theme === "dark" ? "rgba(235,240,255,0.62)" : "rgba(47,39,67,0.58)",
      );
    }
    if (current && (sourceId === current || targetId === current)) {
      return cssVar(
        "--color-graph-link-current",
        theme === "dark" ? "rgba(183,148,246,0.78)" : "rgba(104,66,194,0.62)",
      );
    }
    return sourceNode
      ? clusterColor(sourceNode.clusterIndex, 0.34)
      : cssVar(
          "--color-graph-link-default",
          theme === "dark" ? "rgba(150,162,178,0.24)" : "rgba(48,56,70,0.22)",
        );
  }

  function isHighlightedNode(node: FGNode): boolean {
    return (
      node.filePath === currentFilePath() ||
      node.filePath === selectedNode() ||
      hoveredNode()?.filePath === node.filePath
    );
  }

  function isSoftHighlightedNode(node: FGNode): boolean {
    return isHighlightedNode(node) || connectedToFocus().has(node.filePath);
  }

  function shouldUseCustomNodeObject(node: FGNode): boolean {
    if (isHugeGraph()) return isHighlightedNode(node);
    return !isDenseGraph() || isSoftHighlightedNode(node);
  }

  function linkVisible(link: FGLink): boolean {
    if (!isHugeGraph() || isFocusedLink(link)) return true;
    const sourceId = isObjectNode(link.source) ? link.source.filePath : link.source;
    const targetId = isObjectNode(link.target) ? link.target.filePath : link.target;
    const key = sourceId < targetId ? `${sourceId}\n${targetId}` : `${targetId}\n${sourceId}`;
    return stableHash(key) % (focusedFilePath() ? 12 : 5) === 0;
  }

  function isHighlightedLink(link: FGLink): boolean {
    const sourceId = isObjectNode(link.source) ? link.source.filePath : link.source;
    const targetId = isObjectNode(link.target) ? link.target.filePath : link.target;
    const selected = selectedNode();
    const current = currentFilePath();
    const hovered = hoveredNode()?.filePath;
    return Boolean(
      (selected && (sourceId === selected || targetId === selected)) ||
      (current && (sourceId === current || targetId === current)) ||
      (hovered && (sourceId === hovered || targetId === hovered)),
    );
  }

  function isFocusedLink(link: FGLink): boolean {
    const focus = focusedFilePath();
    if (!focus) return false;
    const sourceId = isObjectNode(link.source) ? link.source.filePath : link.source;
    const targetId = isObjectNode(link.target) ? link.target.filePath : link.target;
    return sourceId === focus || targetId === focus;
  }

  function labelBorderColor(node: FGNode): string {
    if (node.filePath === selectedNode()) {
      return getEffectiveTheme() === "dark"
        ? cssVar("--color-graph-node-selected", "#f4f4f0")
        : cssVar("--color-graph-node-selected", "#d6246f");
    }

    if (focusedFilePath() === node.filePath) return clusterColor(node.clusterIndex, 0.75);
    return clusterColor(node.clusterIndex, 0.3);
  }

  function linkWidth(link: FGLink): number {
    const scale = getGraphSettings("3d").linkWidthScale;
    if (isFocusedLink(link)) return 2.15 * scale;
    if (isHighlightedLink(link)) return 1.1 * scale;
    if (isHugeGraph()) return 0.025 * scale;
    if (isLargeGraph()) return 0.05 * scale;
    if (isDenseGraph()) return 0.12 * scale;
    if (focusedFilePath()) return 0.08 * scale;
    return 0.32 * scale;
  }

  function linkOpacityForSettings(): number {
    return Math.min(1, 0.32 * getGraphSettings("3d").linkOpacity);
  }

  function linkCurvature(link: FGLink): number {
    if (isHugeGraph()) return 0;
    const curvature = getGraphSettings("3d").linkCurvature;
    return isFocusedLink(link) ? curvature * 1.35 : curvature;
  }

  function nodeResolutionForBudget(): number {
    if (isHugeGraph()) return 8;
    if (isLargeGraph()) return 10;
    if (isDenseGraph()) return 10;
    return 16;
  }

  function alphaDecayForBudget(): number {
    const alphaDecay = getGraphSettings("3d").alphaDecay;
    if (isHugeGraph()) return Math.max(alphaDecay, 0.18);
    if (isLargeGraph()) return Math.max(alphaDecay, 0.08);
    if (isDenseGraph()) return Math.max(alphaDecay, 0.045);
    return Math.max(alphaDecay, 0.03);
  }

  function velocityDecayForBudget(): number {
    const velocityDecay = getGraphSettings("3d").velocityDecay;
    if (isHugeGraph()) return Math.max(velocityDecay, 0.74);
    if (isLargeGraph()) return Math.max(velocityDecay, 0.56);
    if (isDenseGraph()) return Math.max(velocityDecay, 0.44);
    return Math.max(velocityDecay, 0.38);
  }

  function warmupTicksForBudget(): number {
    if (isHugeGraph()) return 1;
    if (isLargeGraph()) return 10;
    if (isDenseGraph()) return 24;
    return Math.min(getGraphSettings("3d").warmupTicks, 40);
  }

  function cooldownTicksForBudget(): number {
    if (isHugeGraph()) return 6;
    if (isLargeGraph()) return 42;
    if (isDenseGraph()) return 90;
    return Math.min(getGraphSettings("3d").cooldownTicks, 120);
  }

  function nodeThreeObject(node: FGNode): Group | undefined {
    if (!shouldUseCustomNodeObject(node)) return undefined;

    const radius = nodeVisualRadius(node);
    const color = nodeColor(node);
    const group = new Group();
    const selected = node.filePath === selectedNode();
    const current = node.filePath === currentFilePath();
    const hovered = node.filePath === hoveredNode()?.filePath;
    const hoverOnly = hovered && !selected && !current;
    const highlighted = isHighlightedNode(node);
    const softHighlighted = isSoftHighlightedNode(node);
    const hasFocus = Boolean(focusedFilePath());

    const core = new Mesh(
      NODE_GEOMETRY,
      new MeshPhysicalMaterial({
        color,
        transparent: !selected,
        opacity: nodeOpacity({ selected, highlighted, softHighlighted, hasFocus }),
        roughness: selected ? 0.38 : 0.46,
        metalness: selected ? 0.02 : 0,
        clearcoat: selected ? 0.38 : 0.22,
        clearcoatRoughness: selected ? 0.42 : 0.5,
        transmission: 0,
        thickness: 0,
        depthWrite: selected,
      }),
    );
    const scale = nodeScale(radius, highlighted, softHighlighted);
    core.scale.setScalar(scale);
    group.add(core);

    const showLabel =
      !hoverOnly &&
      (selected ||
        current ||
        (!isDenseGraph() && zoomLevel() >= getGraphSettings("3d").labelVisibilityThreshold));
    if (showLabel) {
      const labelColor = getEffectiveTheme() === "dark" ? "#f7f4ff" : "#1d172b";
      const label = new SpriteText(
        shortLabel(node.name),
        focusedFilePath() === node.filePath ? 3.4 : 2.7,
        labelColor,
      );
      label.fontFace = "Goorm Sans, -apple-system, BlinkMacSystemFont, sans-serif";
      label.fontWeight = focusedFilePath() === node.filePath || current ? "700" : "500";
      label.backgroundColor =
        getEffectiveTheme() === "dark" ? "rgba(18,18,20,0.92)" : "rgba(255,255,255,0.96)";
      label.borderColor = labelBorderColor(node);
      label.borderWidth = focusedFilePath() === node.filePath ? 0.55 : 0.25;
      label.borderRadius = 2;
      label.padding = focusedFilePath() === node.filePath ? [3, 2] : [2, 1.5];
      label.position.y = radius + (focusedFilePath() === node.filePath ? 7 : 4.8);
      label.renderOrder = 1000;
      label.material.depthTest = false;
      label.material.depthWrite = false;
      group.add(label);
    }

    return group;
  }

  function configureForces(options: { reheat?: boolean } = {}): void {
    if (!graphEl) return;
    const cfg = getGraphSettings("3d");
    const budget = renderBudget();
    const dense = budget !== "normal";
    const large = budget === "large";
    const huge = budget === "huge";
    const chargeMultiplier = budgetNumber(budget, {
      normal: 1,
      dense: 0.82,
      large: 0.82,
      huge: 0.55,
    });
    const chargeTheta = budgetNumber(budget, {
      normal: 0.9,
      dense: 1.08,
      large: 1.25,
      huge: 1.5,
    });
    const chargeDistanceMax = budgetNumber(budget, {
      normal: Number.POSITIVE_INFINITY,
      dense: 560,
      large: 360,
      huge: 220,
    });
    const linkDistanceMultiplier = budgetNumber(budget, {
      normal: 1,
      dense: 0.92,
      large: 0.92,
      huge: 0.78,
    });

    graphEl
      .d3AlphaDecay(alphaDecayForBudget())
      .d3VelocityDecay(velocityDecayForBudget())
      .warmupTicks(warmupTicksForBudget())
      .cooldownTicks(cooldownTicksForBudget());

    graphEl
      .d3Force("charge")
      ?.strength?.(
        (node: FGNode) =>
          (node.isOrphan ? cfg.chargeStrengthOrphan * 0.75 : cfg.chargeStrength * 0.8) *
          chargeMultiplier,
      );
    graphEl.d3Force("charge")?.theta?.(chargeTheta);
    graphEl.d3Force("charge")?.distanceMax?.(chargeDistanceMax);
    graphEl.d3Force("center")?.strength?.(cfg.centerStrength);
    graphEl.d3Force("link")?.distance?.(() => cfg.linkDistance * linkDistanceMultiplier);
    graphEl
      .d3Force("link")
      ?.strength?.(() => Math.max(0, cfg.linkStrength) * (dense ? 0.42 : 0.68));
    graphEl.d3Force("link")?.iterations?.(dense ? 1 : 2);

    const clusters = graphState()?.clusters ?? [];
    if (clusters.length > 1 && !large && !huge) {
      const { width, height } = dimensions();
      const clusterRadius = Math.min(width, height) * cfg.clusterRadiusFactor * 0.7;
      const angleStep = (2 * Math.PI) / clusters.length;
      const centers = new Map<number, { x: number; y: number; z: number }>();

      clusters.forEach((_: string, i: number) => {
        const angle = i * angleStep - Math.PI / 2;
        centers.set(i, {
          x: Math.cos(angle) * clusterRadius,
          y: Math.sin(angle) * clusterRadius,
          z: Math.sin(angle * 1.7) * clusterRadius * 0.34,
        });
      });

      graphEl.d3Force("cluster", (alpha: number) => {
        const data = graphEl?.graphData();
        if (!data) return;
        for (const node of data.nodes) {
          const center = centers.get(node.clusterIndex);
          if (!center) continue;
          const strength = cfg.clusterStrength * alpha * (dense ? 0.34 : 0.72);
          node.vx = (node.vx ?? 0) + (center.x - (node.x ?? 0)) * strength;
          node.vy = (node.vy ?? 0) + (center.y - (node.y ?? 0)) * strength;
          node.vz = (node.vz ?? 0) + (center.z - (node.z ?? 0)) * strength;
        }
      });
    } else {
      graphEl.d3Force("cluster", null);
    }

    if (options.reheat) {
      graphEl.d3ReheatSimulation();
    }
  }

  function updateZoomFromCamera(): void {
    if (!graphEl) return;
    const { x, y, z } = graphEl.cameraPosition();
    const dist = Math.max(1, Math.sqrt(x * x + y * y + z * z));
    setZoomLevel(Math.max(0.1, Math.min(8, 480 / dist)));
  }

  function cancelCameraAnimation(): void {
    if (cameraAnimationFrame !== undefined) {
      cancelAnimationFrame(cameraAnimationFrame);
      cameraAnimationFrame = undefined;
    }
    isCameraAnimating = false;
  }

  function smoothCameraTo(camera: CameraPoint, lookAt: CameraPoint, duration = 760): void {
    if (!graphEl) return;
    cancelCameraAnimation();

    const startCamera = graphEl.cameraPosition();
    const target = (graphEl.controls() as { target?: CameraPoint }).target;
    const startLookAt = target ? { x: target.x, y: target.y, z: target.z } : { x: 0, y: 0, z: 0 };
    const startedAt = performance.now();
    isCameraAnimating = true;

    const tick = (now: number) => {
      if (!graphEl) return;
      const progress = Math.min(1, (now - startedAt) / duration);
      const eased = easeOutQuart(progress);
      graphEl.cameraPosition(
        lerpPoint(startCamera, camera, eased),
        lerpPoint(startLookAt, lookAt, eased),
        0,
      );

      if (progress < 1) {
        cameraAnimationFrame = requestAnimationFrame(tick);
        return;
      }

      cameraAnimationFrame = undefined;
      isCameraAnimating = false;
      updateZoomFromCamera();
    };

    cameraAnimationFrame = requestAnimationFrame(tick);
  }

  function zoomIn(): void {
    if (!graphEl) return;
    graphEl.cameraPosition(
      cameraDistanceForZoom(graphEl.cameraPosition(), 0.72),
      { x: 0, y: 0, z: 0 },
      300,
    );
    setTimeout(updateZoomFromCamera, 340);
  }

  function zoomOut(): void {
    if (!graphEl) return;
    graphEl.cameraPosition(
      cameraDistanceForZoom(graphEl.cameraPosition(), 1.32),
      { x: 0, y: 0, z: 0 },
      300,
    );
    setTimeout(updateZoomFromCamera, 340);
  }

  function fitView(): void {
    if (!graphEl) return;
    graphEl.zoomToFit(500, 72);
    setTimeout(updateZoomFromCamera, 560);
  }

  function resetView(): void {
    if (!graphEl) return;
    cancelCameraAnimation();
    for (const node of graphEl.graphData().nodes) {
      node.fx = undefined;
      node.fy = undefined;
      node.fz = undefined;
    }
    graphEl.cameraPosition({ x: 0, y: 0, z: 520 }, { x: 0, y: 0, z: 0 }, 500);
    graphEl.d3ReheatSimulation();
    setZoomLevel(1);
  }

  function locateNode(filePath: string): void {
    if (!graphEl) return;
    const node = graphEl.graphData().nodes.find((n) => n.filePath === filePath);
    if (node?.x === undefined || node.y === undefined || node.z === undefined) return;

    const currentCamera = graphEl.cameraPosition();
    const dx = currentCamera.x - node.x;
    const dy = currentCamera.y - node.y;
    const dz = currentCamera.z - node.z;
    const len = Math.hypot(dx, dy, dz) || 1;
    const dist = Math.max(220, nodeRadius(node) * 18 + 150);
    const camera = {
      x: node.x + (dx / len) * dist,
      y: node.y + (dy / len) * dist,
      z: node.z + (dz / len) * dist,
    };
    setHoveredNode(null);
    setSelectedNode(filePath);
    graphEl.refresh();
    smoothCameraTo(camera, { x: node.x, y: node.y, z: node.z });
    setZoomLevel(Math.max(0.1, Math.min(8, 480 / dist)));
  }

  function handleNodeClick(node: FGNode): void {
    locateNode(node.filePath);
    props.onNodeClick?.(node);
  }

  onMount(() => {
    if (!hostEl) return;

    try {
      const instance = new Graph3DConstructor(hostEl, {
        controlType: "orbit",
        rendererConfig: { alpha: true, antialias: true, powerPreference: "high-performance" },
      })
        .graphData({ nodes: [], links: [] })
        .nodeId("id")
        .nodeVal((node) => Math.max(2, nodeRadius(node)))
        .nodeColor((node) => nodeColor(node))
        .nodeThreeObject((node) => nodeThreeObject(node) as Group)
        .nodeRelSize(GRAPH_3D_NODE_REL_SIZE)
        .nodeResolution(nodeResolutionForBudget())
        .linkColor((link) => linkColor(link))
        .linkWidth((link) => linkWidth(link))
        .linkVisibility((link) => linkVisible(link))
        .linkOpacity(linkOpacityForSettings())
        .linkCurvature((link) => linkCurvature(link))
        .linkDirectionalArrowLength((link) => {
          const settings = getGraphSettings("3d");
          return settings.showArrows && isFocusedLink(link) ? settings.arrowLength * 1.25 : 0;
        })
        .linkDirectionalArrowRelPos(0.92)
        .linkDirectionalParticles((link) => (isFocusedLink(link) ? 2 : 0))
        .linkDirectionalParticleWidth(1.4)
        .linkDirectionalParticleSpeed(0.004)
        .linkDirectionalParticleColor((link) => linkColor(link))
        .onNodeClick((node) => handleNodeClick(node))
        .onNodeHover((node) => {
          if (isCameraAnimating) return;
          if (isHugeGraph()) {
            const now = performance.now();
            if (now - lastHugeHoverAt < 110) return;
            lastHugeHoverAt = now;
          }
          pendingHoveredNode = node;
          if (hoverFrame !== undefined) return;
          hoverFrame = requestAnimationFrame(() => {
            hoverFrame = undefined;
            const next = pendingHoveredNode ?? null;
            pendingHoveredNode = undefined;
            if (hoveredNode()?.filePath === next?.filePath) return;
            setHoveredNode(next);
          });
        })
        .onBackgroundClick(() => {
          setSelectedNode(null);
          setHoveredNode(null);
          props.onBackgroundClick?.();
        })
        .showPointerCursor(hasGraphPointerTarget)
        .showNavInfo(false)
        .backgroundColor("rgba(0,0,0,0)")
        .enableNodeDrag(false)
        .enableNavigationControls(true);

      graphEl = instance;
      instance
        .renderer()
        .setPixelRatio(isDenseGraph() ? 1 : Math.min(window.devicePixelRatio, 1.5));
      const controls = instance.controls() as { zoomSpeed?: number };
      controls.zoomSpeed = GRAPH_3D_SCROLL_ZOOM_SPEED;

      const rect = hostEl.getBoundingClientRect();
      setDimensions({ width: rect.width, height: rect.height });
      instance.width(rect.width).height(rect.height);
      instance.cameraPosition({ x: 0.001, y: 0, z: 520 }, { x: 0, y: 0, z: 0 }, 0);

      resizeObs = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const { width, height } = entry.contentRect;
          setDimensions({ width, height });
          graphEl?.width(Math.max(1, Math.floor(width))).height(Math.max(1, Math.floor(height)));
        }
      });
      resizeObs.observe(hostEl);

      props.onHandle?.({ zoomIn, zoomOut, fitView, resetView, locateNode });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // eslint-disable-next-line no-console
      console.error("[GraphCanvas3D] Init failed:", error);
      setInitError(message);
    }
  });

  createEffect(
    on(
      () => {
        const state = graphState();
        return state
          ? [state.lastIndexedAt, state.nodes.length, state.links.length, state.clusters.length]
          : [null, 0, 0, 0];
      },
      () => {
        if (!graphEl) return;
        const s = graphState();
        if (!s || s.nodes.length === 0) return;

        const nodes: FGNode[] = s.nodes.map((n) => ({ ...n }));
        const links: FGLink[] = s.links.map((l) => ({ ...l }));
        graphEl.graphData({ nodes, links });
        graphEl.nodeResolution(nodeResolutionForBudget());
        graphEl.linkVisibility((link) => linkVisible(link));
        graphEl
          .renderer()
          .setPixelRatio(isDenseGraph() ? 1 : Math.min(window.devicePixelRatio, 1.5));

        requestAnimationFrame(() => configureForces());
      },
    ),
  );

  createEffect(
    on(
      () => {
        const settings = getGraphSettings("3d");
        return [
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
          settings.linkOpacity,
          settings.linkWidthScale,
          settings.showArrows,
          settings.labelVisibilityThreshold,
          settings.hoverFadeOpacity,
          settings.linkCurvature,
          settings.arrowLength,
        ] as const;
      },
      () => {
        if (!graphEl) return;
        graphEl
          .nodeVal((node) => Math.max(2, nodeRadius(node)))
          .linkWidth((link) => linkWidth(link))
          .linkOpacity(linkOpacityForSettings())
          .linkCurvature((link) => linkCurvature(link))
          .linkDirectionalArrowLength((link) => {
            const settings = getGraphSettings("3d");
            return settings.showArrows && isFocusedLink(link) ? settings.arrowLength * 1.25 : 0;
          });
        configureForces({ reheat: true });
        graphEl.refresh();
      },
      { defer: true },
    ),
  );

  createEffect(
    on(
      () => graphAnimationReplayRevision(),
      () => {
        if (!graphEl) return;
        configureForces({ reheat: true });
        graphEl.refresh();
      },
      { defer: true },
    ),
  );

  createEffect(
    on(
      () => [hoveredNode(), selectedNode(), currentFilePath()] as const,
      () => {
        if (!graphEl) return;
        graphEl.refresh();
      },
      { defer: true },
    ),
  );

  createEffect(
    on(
      () => getEffectiveTheme(),
      () => {
        cssVarCache.clear();
        graphEl?.refresh();
      },
      { defer: true },
    ),
  );

  createEffect(
    on(
      () => currentFilePath(),
      (fp) => {
        if (fp) setSelectedNode(fp);
        graphEl?.refresh();
      },
      { defer: true },
    ),
  );

  createEffect(() => {
    if (!followMode()) return;
    const fp = currentFilePath();
    if (fp) locateNode(fp);
  });

  onCleanup(() => {
    cancelCameraAnimation();
    if (hoverFrame !== undefined) {
      cancelAnimationFrame(hoverFrame);
      hoverFrame = undefined;
    }
    resizeObs?.disconnect();
    resizeObs = undefined;
    if (graphEl) {
      try {
        // eslint-disable-next-line no-underscore-dangle
        graphEl._destructor();
      } catch {
        /* noop */
      }
      graphEl = undefined;
    }
    if (hostEl) {
      while (hostEl.firstChild) hostEl.removeChild(hostEl.firstChild);
    }
    cssVarCache.clear();
  });

  return (
    <div
      class={`relative min-h-0 min-w-0 flex-1 overflow-hidden bg-bg-primary ${props.class ?? ""}`}
    >
      <div ref={hostEl} class="absolute inset-0" />

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
          <CtrlBtn title={t("graph.ctrl.fit_all")} onClick={fitView} compact={isCompact()}>
            <FitViewIcon />
          </CtrlBtn>
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
            compact={isCompact()}
          >
            <LocateIcon />
          </CtrlBtn>
          <CtrlBtn title={t("graph.ctrl.reset_view")} onClick={resetView} compact={isCompact()}>
            <ResetViewIcon />
          </CtrlBtn>
          <span
            class="flex h-6 w-8 items-center justify-center px-0 text-center font-mono text-[0.625rem] text-text-muted tabular-nums"
            classList={{ "h-5 w-6 text-[0.5625rem]": isCompact() }}
          >
            {Math.round(zoomLevel() * 100)}%
          </span>
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
