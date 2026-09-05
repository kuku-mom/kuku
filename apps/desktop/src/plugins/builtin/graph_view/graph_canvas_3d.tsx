// ── Graph Canvas 3D ──
//
// Three.js Quiet Constellation renderer for the graph tab and compact panel.
// It intentionally shares GraphStore and GraphCanvasHandle with the 2D canvas
// so the tab can switch renderers without changing graph indexing or
// navigation behavior.
//
// Rendering architecture: ALL node stars live in a single THREE.Points draw
// call with a crisp circular core, restrained halo, and selection ring. Per node the scene only carries an invisible
// low-poly raycast proxy, so hover/selection changes are O(n) typed-array
// attribute writes — no object or material churn. Clusters settle
// volumetrically through 3D space (no galactic plane); the galaxy look comes
// from folder separation, hub size, and depth dimming. Theme-aware: additive blending on dark,
// normal blending with darker pigments on light.

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
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { attachGraphTrackpadControls } from "./graph_trackpad_controls";
import {
  AdditiveBlending,
  BufferGeometry,
  Box3,
  Color,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshBasicMaterial,
  NormalBlending,
  Points,
  type PerspectiveCamera,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
} from "three";

import { currentLocale, t, tf } from "~/i18n";
import { settingsState } from "~/stores/settings";
import { getEffectiveTheme } from "~/stores/theme";

import {
  constellationColor,
  constellationCenters,
  constellationLabelCandidates,
  seedConstellation,
} from "./graph_constellation";

import { graphAnimationReplayRevision } from "./graph_animation";
import { getGraphStore } from "./graph_store";
import { getGraphSettings } from "./graph_settings";
import {
  GRAPH_3D_SCROLL_ZOOM_SPEED,
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

const GRAPH_3D_NODE_REL_SIZE = 1;
const Graph3DConstructor = ForceGraph3D as unknown as Graph3DConstructor;
const DENSE_GRAPH_NODE_COUNT = 500;
const LARGE_GRAPH_NODE_COUNT = 1_000;
const HUGE_GRAPH_NODE_COUNT = 1_500;
const DENSE_LINK_RATIO = 2.2;
const LARGE_LINK_RATIO = 3;
const HUGE_LINK_RATIO = 4;

// ── Universe rendering ────────────────────────────────────────
//
// Two Points layers total: the background starfield and the node-star layer.
// Twinkling and star shading happen entirely in shaders off a handful of
// uniforms; per-node hover/selection state is pushed as buffer attributes.

const WHITE = new Color("#ffffff");
const STARFIELD_COUNT_FULL = 180;
const STARFIELD_COUNT_COMPACT = 48;
const STAR_TINTS_DARK = ["#ffffff", "#ffffff", "#cfe0ff", "#ffeccf", "#e2d6ff"];
const STAR_TINTS_LIGHT = ["#3c4356", "#3c4356", "#4a4f6e", "#6b5e8a", "#54648a"];

/** Universe self-rotation (around y) in rad/s — a restrained, nearly still overview. */
const GALAXY_ROTATION_SPEED = 0.003;
/** Keep the view steady for a while after locating a node. */
const GALAXY_LOCATE_GRACE_MS = 6000;
const GALAXY_HALO_RADIUS_RATIO = 1.45;
const GALAXY_INITIAL_CAMERA: CameraPoint = { x: 0, y: 0, z: 780 };

/** Pixel size multiplier from node visual radius to star point size. */
const STAR_SIZE_BASE = 6.4;
const LABEL_FONT_FALLBACK = '"Goorm Sans", -apple-system, BlinkMacSystemFont, sans-serif';

/**
 * Invisible raycast proxy shared by every node: hover/click picking needs a
 * mesh per node, but it never draws a fragment (colorWrite off) and shares
 * one geometry + one material across the whole graph.
 */
const NODE_PROXY_GEOMETRY = new SphereGeometry(1, 6, 4);
const NODE_PROXY_MATERIAL = new MeshBasicMaterial({
  transparent: true,
  opacity: 0,
  depthWrite: false,
  colorWrite: false,
});

const STARFIELD_VERTEX = /* glsl */ `
  attribute float aSize;
  attribute float aPhase;
  attribute vec3 aColor;
  uniform float uTime;
  uniform float uPixelRatio;
  varying float vAlpha;
  varying vec3 vColor;

  void main() {
    vColor = aColor;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    float twinkle = 0.88 + 0.12 * sin(uTime * (0.5 + aPhase * 1.9) + aPhase * 6.2831);
    vAlpha = twinkle;
    gl_PointSize = min(aSize * uPixelRatio * (2400.0 / -mvPosition.z), 9.0 * uPixelRatio);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const STARFIELD_FRAGMENT = /* glsl */ `
  uniform float uOpacity;
  varying float vAlpha;
  varying vec3 vColor;

  void main() {
    float dist = length(gl_PointCoord - 0.5);
    float alpha = 1.0 - smoothstep(0.08, 0.5, dist);
    gl_FragColor = vec4(vColor, alpha * vAlpha * uOpacity);
    #include <colorspace_fragment>
  }
`;

const NODE_STAR_VERTEX = /* glsl */ `
  attribute float aSize;
  attribute float aAlpha;
  attribute float aSelected;
  attribute vec3 aColor;
  uniform float uPixelRatio;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vSelected;

  void main() {
    vColor = aColor;
    vSelected = aSelected;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    // Slight distance dimming sells volumetric depth without a fog pass.
    vAlpha = aAlpha * clamp(1.2 - (-mvPosition.z) / 3000.0, 0.55, 1.0);
    gl_PointSize = clamp(aSize * uPixelRatio * (1100.0 / -mvPosition.z), 9.0 * uPixelRatio, mix(24.0, 44.0, vSelected) * uPixelRatio);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const NODE_STAR_FRAGMENT = /* glsl */ `
  uniform float uOpacity;
  uniform float uHot;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vSelected;

  void main() {
    vec2 uv = gl_PointCoord * 2.0 - 1.0;
    float d = length(uv);
    // Crisp circular pigment with a narrow halo; selection gets a fine ring.
    float core = 1.0 - smoothstep(0.30, 0.42, d);
    float halo = exp(-d * d * 15.0) * 0.18 * uHot;
    float ring = (smoothstep(0.61, 0.65, d) - smoothstep(0.70, 0.74, d)) * vSelected;
    float alpha = (core + halo + ring * 0.65) * vAlpha * uOpacity;
    if (alpha < 0.01) discard;
    vec3 color = mix(vColor, vec3(1.0), core * uHot * 0.28);
    gl_FragColor = vec4(color, alpha);
    #include <colorspace_fragment>
  }
`;

/** Deterministic PRNG so the star layout survives theme rebuilds unchanged. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 1831565813; // 0x6D2B79F5 (mulberry32 increment)
    let mixed = a;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function createStarfield(theme: "dark" | "light", count: number, pixelRatio: number): Points {
  const rand = mulberry32(1337);
  const positions = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const phases = new Float32Array(count);
  const colors = new Float32Array(count * 3);
  const tints = (theme === "dark" ? STAR_TINTS_DARK : STAR_TINTS_LIGHT).map(
    (tint) => new Color(tint),
  );

  for (let i = 0; i < count; i++) {
    // Uniform direction on a sphere, pushed out into a wide shell so stars
    // always sit behind the graph regardless of camera orbit.
    const radius = 1500 + rand() * 1700;
    const theta = rand() * Math.PI * 2;
    const cosPhi = rand() * 2 - 1;
    const sinPhi = Math.sqrt(1 - cosPhi * cosPhi);
    positions[i * 3] = radius * sinPhi * Math.cos(theta);
    positions[i * 3 + 1] = radius * cosPhi;
    positions[i * 3 + 2] = radius * sinPhi * Math.sin(theta);
    sizes[i] = 0.5 + rand() * 0.7;
    phases[i] = rand();
    const tint = tints[Math.floor(rand() * tints.length)] ?? WHITE;
    colors[i * 3] = tint.r;
    colors[i * 3 + 1] = tint.g;
    colors[i * 3 + 2] = tint.b;
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setAttribute("aSize", new Float32BufferAttribute(sizes, 1));
  geometry.setAttribute("aPhase", new Float32BufferAttribute(phases, 1));
  geometry.setAttribute("aColor", new Float32BufferAttribute(colors, 3));

  const material = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: theme === "dark" ? AdditiveBlending : NormalBlending,
    uniforms: {
      uTime: { value: 0 },
      uPixelRatio: { value: pixelRatio },
      uOpacity: { value: theme === "dark" ? 0.24 : 0.035 },
    },
    vertexShader: STARFIELD_VERTEX,
    fragmentShader: STARFIELD_FRAGMENT,
  });

  const points = new Points(geometry, material);
  points.renderOrder = -20;
  points.frustumCulled = false;
  return points;
}

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
  if (options.highlighted) return 1;
  if (options.softHighlighted) return 0.92;
  if (options.hasFocus) return Math.sqrt(Math.max(0, fadeOpacity));
  return 0.88;
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
  return Math.sqrt(Math.max(2, nodeRadius(node))) * 0.85 * GRAPH_3D_NODE_REL_SIZE;
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

function disposeLabel(sprite: SpriteText): void {
  sprite.parent?.remove(sprite);
  sprite.material.map?.dispose();
  sprite.material.dispose();
}

export default function GraphCanvas3D(props: GraphCanvas3DProps) {
  let hostEl: HTMLDivElement | undefined;
  let graphEl: Graph3D | undefined;
  let resizeObs: ResizeObserver | undefined;
  let cameraAnimationFrame: number | undefined;
  let zoomFrame: number | undefined;
  let isCameraAnimating = false;
  let pendingHoveredNode: FGNode | null | undefined;
  let hoverFrame: number | undefined;
  let lastHugeHoverAt = 0;
  let dataFrame: number | undefined;
  let lastLabelLayoutAt = 0;
  let lastControlInteractionAt = 0;
  let fitOnEngineStop = true;
  let removeTrackpadControls: (() => void) | undefined;
  let removeControlsChangeListener: (() => void) | undefined;

  const cssVarCache = new Map<string, string>();

  // Raycast proxies keyed by node id — refresh() re-runs nodeThreeObject for
  // every node, so returning the cached instance makes a refresh allocation-
  // free for nodes. Cleared when data or sizing settings change.
  const proxyCache = new Map<string, Mesh>();

  // CSS color string → THREE.Color, shared by all star attribute updates.
  const parsedColorCache = new Map<string, Color>();

  function parsedColor(css: string): Color {
    let color = parsedColorCache.get(css);
    if (!color) {
      color = new Color(css);
      parsedColorCache.set(css, color);
    }
    return color;
  }

  /** Resolve theme tokens from the graph host (same pattern as 2D canvas). */
  function cssVar(name: string, fallback = ""): string {
    if (!hostEl) return fallback;
    const cached = cssVarCache.get(name);
    if (cached !== undefined) return cached;
    const value = getComputedStyle(hostEl).getPropertyValue(name).trim() || fallback;
    cssVarCache.set(name, value);
    return value;
  }

  function labelFontFamily(): string {
    return cssVar("--font-editor", LABEL_FONT_FALLBACK);
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

  const focusedFilePath = createMemo(() => {
    const paths = new Set(graphState()?.nodes.map((node) => node.filePath));
    return (
      [hoveredNode()?.filePath, selectedNode(), currentFilePath()].find(
        (path) => path && paths.has(path),
      ) ?? null
    );
  });

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

  // ── Universe scenery state ──
  let starfield: Points | undefined;
  let sceneryFrame: number | undefined;
  let sceneryStartedAt = 0;
  let lastSceneryFrameAt = 0;
  /** The ThreeForceGraph group inside the scene — rotated for universe spin. */
  let graphObj: Group | undefined;
  let galaxyAngle = 0;
  let lastLocateAt = 0;

  // ── Node star layer (one draw call for every node) ──
  let nodeStars: Points | undefined;
  let starNodes: FGNode[] = [];
  const nodeByPath = new Map<string, FGNode>();
  let labelGroup: Group | undefined;
  const labelSprites = new Map<string, SpriteText>();

  function galaxyRadius(): number {
    const { width, height } = dimensions();
    return Math.min(width, height) * getGraphSettings("3d").clusterRadiusFactor * 0.53;
  }

  function disposeScenery(): void {
    if (starfield && graphEl) {
      graphEl.scene().remove(starfield);
      starfield.geometry.dispose();
      (starfield.material as ShaderMaterial).dispose();
    }
    starfield = undefined;
  }

  /**
   * (Re)build the background starfield for the active theme. Deliberately no
   * soft glow sprites (galactic core, nebulas, dust blobs): large additive
   * shapes stack into a washed-out haze, so only point-sized scenery exists.
   */
  function buildScenery(): void {
    if (!graphEl) return;
    disposeScenery();
    starfield = createStarfield(
      getEffectiveTheme(),
      isCompact() ? STARFIELD_COUNT_COMPACT : STARFIELD_COUNT_FULL,
      graphEl.renderer().getPixelRatio(),
    );
    graphEl.scene().add(starfield);
  }

  function disposeNodeStars(): void {
    if (nodeStars) {
      nodeStars.parent?.remove(nodeStars);
      nodeStars.geometry.dispose();
      (nodeStars.material as ShaderMaterial).dispose();
    }
    nodeStars = undefined;
    starNodes = [];
    nodeByPath.clear();
  }

  /** Rebuild the node-star Points layer from the current graph data. */
  function buildNodeStars(): void {
    if (!graphEl) return;
    disposeNodeStars();
    const { nodes } = graphEl.graphData();
    if (nodes.length === 0) return;
    starNodes = nodes;
    for (const node of nodes) nodeByPath.set(node.filePath, node);

    const n = nodes.length;
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute(new Float32Array(n * 3), 3));
    geometry.setAttribute("aColor", new Float32BufferAttribute(new Float32Array(n * 3), 3));
    geometry.setAttribute("aSize", new Float32BufferAttribute(new Float32Array(n), 1));
    geometry.setAttribute("aAlpha", new Float32BufferAttribute(new Float32Array(n), 1));
    geometry.setAttribute("aSelected", new Float32BufferAttribute(new Float32Array(n), 1));

    const dark = getEffectiveTheme() === "dark";
    const material = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: dark ? AdditiveBlending : NormalBlending,
      uniforms: {
        uPixelRatio: { value: graphEl.renderer().getPixelRatio() },
        uOpacity: { value: 1 },
        uHot: { value: dark ? 0.65 : 0.04 },
      },
      vertexShader: NODE_STAR_VERTEX,
      fragmentShader: NODE_STAR_FRAGMENT,
    });

    nodeStars = new Points(geometry, material);
    nodeStars.frustumCulled = false;
    nodeStars.renderOrder = 10;
    // Child of the graph group → inherits the universe spin automatically.
    (graphObj ?? graphEl.scene()).add(nodeStars);
    syncStarPositions();
    updateStarVisuals();
  }

  /** Copy simulation positions into the star buffer (runs per engine tick). */
  function syncStarPositions(): void {
    if (!nodeStars || starNodes.length === 0) return;
    const attr = nodeStars.geometry.getAttribute("position") as Float32BufferAttribute;
    const arr = attr.array as Float32Array;
    for (let i = 0; i < starNodes.length; i++) {
      const node = starNodes[i];
      if (!node) continue;
      arr[i * 3] = node.x ?? 0;
      arr[i * 3 + 1] = node.y ?? 0;
      arr[i * 3 + 2] = node.z ?? 0;
    }
    attr.needsUpdate = true;
    for (const [filePath, sprite] of labelSprites) {
      const node = nodeByPath.get(filePath);
      if (node) {
        sprite.position.set(node.x ?? 0, node.y ?? 0, node.z ?? 0);
      }
    }
  }

  /**
   * Push hover/selection/theme state into star attributes. O(n) typed-array
   * writes — replaces the old per-node object/material rebuild entirely.
   */
  function updateStarVisuals(): void {
    if (!nodeStars || starNodes.length === 0) return;
    const geometry = nodeStars.geometry;
    const colorAttr = geometry.getAttribute("aColor") as Float32BufferAttribute;
    const sizeAttr = geometry.getAttribute("aSize") as Float32BufferAttribute;
    const alphaAttr = geometry.getAttribute("aAlpha") as Float32BufferAttribute;
    const selectionAttr = geometry.getAttribute("aSelected") as Float32BufferAttribute;
    const colors = colorAttr.array as Float32Array;
    const sizes = sizeAttr.array as Float32Array;
    const alphas = alphaAttr.array as Float32Array;
    const selections = selectionAttr.array as Float32Array;

    const selected = selectedNode();
    const connected = connectedToFocus();
    const hasFocus = Boolean(focusedFilePath());

    for (let i = 0; i < starNodes.length; i++) {
      const node = starNodes[i];
      if (!node) continue;
      const highlighted = isHighlightedNode(node);
      const soft = highlighted || connected.has(node.filePath);
      const color = parsedColor(nodeColor(node));
      colors[i * 3] = color.r;
      colors[i * 3 + 1] = color.g;
      colors[i * 3 + 2] = color.b;
      let scale = 1;
      if (highlighted) scale = 1.3;
      else if (soft) scale = 1.12;
      sizes[i] = nodeVisualRadius(node) * STAR_SIZE_BASE * scale;
      // Hubs burn brighter — luminosity tracks connectivity like a real
      // cluster core, so the structure itself carries the galaxy look.
      const luminosity = 1 + Math.min(node.linkCount, 8) * 0.035;
      alphas[i] = Math.min(
        1,
        nodeOpacity({
          selected: node.filePath === selected,
          highlighted,
          softHighlighted: soft,
          hasFocus,
        }) * luminosity,
      );
      selections[i] = node.filePath === selected || node.filePath === currentFilePath() ? 1 : 0;
    }
    colorAttr.needsUpdate = true;
    sizeAttr.needsUpdate = true;
    alphaAttr.needsUpdate = true;
    selectionAttr.needsUpdate = true;
  }

  function clearLabels(): void {
    for (const sprite of labelSprites.values()) disposeLabel(sprite);
    labelSprites.clear();
  }

  function isEmphasizedLabel(node: FGNode): boolean {
    return node.filePath === selectedNode() || node.filePath === currentFilePath();
  }

  function configureLabel(sprite: SpriteText, node: FGNode, dark: boolean): void {
    if (!graphEl) return;
    const emphasized = isEmphasizedLabel(node);
    sprite.text = shortLabel(node.name);
    // Constant screen-size text remains readable at overview and close range.
    const pixelsToWorld =
      (2 * Math.tan(((graphEl.camera() as PerspectiveCamera).fov * Math.PI) / 360)) /
      Math.max(1, dimensions().height);
    sprite.textHeight = emphasized ? 13 : 12;
    sprite.material.sizeAttenuation = false;
    sprite.color = dark ? "#f7f4ff" : "#1d172b";
    sprite.fontFace = labelFontFamily();
    sprite.fontWeight = emphasized ? "600" : "400";
    sprite.backgroundColor = cssVar("--color-bg-primary", dark ? "#1a1a1a" : "#ffffff");
    sprite.borderColor = labelBorderColor(node);
    sprite.borderWidth = emphasized ? 0.2 : 0;
    sprite.borderRadius = 2;
    sprite.padding = [4, 2];
    sprite.scale.multiplyScalar(pixelsToWorld);
    sprite.center.set(-(emphasized ? 22 : 10) / (sprite.scale.x / pixelsToWorld), 0.5);
    sprite.renderOrder = 1000;
    sprite.material.depthTest = false;
    sprite.material.depthWrite = false;
    sprite.position.set(node.x ?? 0, node.y ?? 0, node.z ?? 0);
  }

  function updateLabels(): void {
    if (!graphEl) return;
    if (!labelGroup) {
      labelGroup = new Group();
      (graphObj ?? graphEl.scene()).add(labelGroup);
    }

    const targets = new Set(
      constellationLabelCandidates(
        starNodes,
        [selectedNode(), currentFilePath(), hoveredNode()?.filePath],
        Math.min(isCompact() ? 4 : 12, isHugeGraph() ? 6 : 12),
        !isDenseGraph() && zoomLevel() >= getGraphSettings("3d").labelVisibilityThreshold,
      ),
    );

    for (const [filePath, sprite] of labelSprites) {
      if (!targets.has(filePath) || !nodeByPath.has(filePath)) {
        disposeLabel(sprite);
        labelSprites.delete(filePath);
      }
    }

    const dark = getEffectiveTheme() === "dark";
    for (const filePath of targets) {
      const node = nodeByPath.get(filePath);
      if (!node) continue;
      let label = labelSprites.get(filePath);
      if (!label) {
        label = new SpriteText();
        labelGroup.add(label);
        labelSprites.set(filePath, label);
      }
      configureLabel(label, node, dark);
    }
    layoutLabels();
  }

  function layoutLabels(): void {
    if (!graphEl || !labelGroup) return;
    const { width, height } = dimensions();
    const camera = graphEl.camera() as PerspectiveCamera;
    const pixelsToWorld = (2 * Math.tan((camera.fov * Math.PI) / 360)) / Math.max(1, height);
    const occupied: { x: number; y: number; w: number }[] = [];
    labelGroup.updateWorldMatrix(true, true);
    const labels = [...labelSprites.entries()].sort(
      ([a], [b]) =>
        Number(b === selectedNode() || b === currentFilePath()) -
        Number(a === selectedNode() || a === currentFilePath()),
    );
    for (const [, sprite] of labels) {
      const point = sprite.getWorldPosition(new Vector3()).project(camera);
      const x = ((point.x + 1) * width) / 2 - (sprite.center.x * sprite.scale.x) / pixelsToWorld;
      const y = ((1 - point.y) * height) / 2;
      const w = sprite.scale.x / pixelsToWorld;
      sprite.visible =
        point.z > -1 &&
        point.z < 1 &&
        x > 0 &&
        x + w < width - 60 &&
        y > 16 &&
        y < height - 56 &&
        !occupied.some(
          (box) => Math.abs(box.y - y) < 24 && x < box.x + box.w + 10 && x + w + 10 > box.x,
        );
      if (sprite.visible) occupied.push({ x, y, w });
    }
  }

  /** Galaxy spin pauses while the user is inspecting something specific. */
  function galaxyRotationActive(now: number): boolean {
    return (
      !isCameraAnimating &&
      now - lastControlInteractionAt > GALAXY_LOCATE_GRACE_MS &&
      !hoveredNode() &&
      !selectedNode() &&
      !followMode() &&
      now - lastLocateAt > GALAXY_LOCATE_GRACE_MS &&
      status() === "ready"
    );
  }

  /** Drives starfield twinkle + the slow self-rotation of the universe. */
  function startSceneryLoop(): void {
    if (sceneryFrame !== undefined) return;
    sceneryStartedAt = performance.now();
    lastSceneryFrameAt = sceneryStartedAt;
    const tick = (now: number) => {
      sceneryFrame = requestAnimationFrame(tick);
      const dt = Math.min(100, now - lastSceneryFrameAt);
      lastSceneryFrameAt = now;

      if (now - lastLabelLayoutAt > 120) {
        layoutLabels();
        lastLabelLayoutAt = now;
      }
      if (starfield) {
        const uTime = (starfield.material as ShaderMaterial).uniforms.uTime;
        if (uTime) uTime.value = (now - sceneryStartedAt) / 1000;
        starfield.rotation.y += 0.00012;
      }

      if (galaxyRotationActive(now) && graphObj) {
        galaxyAngle += (dt / 1000) * GALAXY_ROTATION_SPEED;
        graphObj.rotation.y = galaxyAngle;
      }
    };
    sceneryFrame = requestAnimationFrame(tick);
  }

  function stopSceneryLoop(): void {
    if (sceneryFrame !== undefined) {
      cancelAnimationFrame(sceneryFrame);
      sceneryFrame = undefined;
    }
  }

  function graphClusterColor(index: number, alpha?: number): string {
    return constellationColor(index, getEffectiveTheme(), alpha);
  }

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
    return graphClusterColor(node.clusterIndex);
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
        return sourceNode
          ? graphClusterColor(sourceNode.clusterIndex, 0.18)
          : "rgba(120,130,160,0.13)";
      }

      if (sourceNode) return graphClusterColor(sourceNode.clusterIndex, 0.72);
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
      ? graphClusterColor(sourceNode.clusterIndex, getEffectiveTheme() === "dark" ? 0.24 : 0.28)
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
      return getEffectiveTheme() === "dark" ? "#303645" : "#e2e4ec";
    }
    return graphClusterColor(node.clusterIndex, 0.25);
  }

  // Width 0 makes three-forcegraph render the link as a plain 2-vertex Line
  // instead of a cylinder mesh — orders of magnitude cheaper. Only the few
  // focused/highlighted links get real tube geometry.
  function linkWidth(link: FGLink): number {
    const scale = getGraphSettings("3d").linkWidthScale;
    if (isFocusedLink(link)) return 0.38 * scale;
    if (isHighlightedLink(link)) return 0.2 * scale;
    return 0;
  }

  function linkOpacityForSettings(): number {
    return Math.min(1, 0.7 * getGraphSettings("3d").linkOpacity);
  }

  // Straight links everywhere except the focused ones: curvature forces
  // multi-segment geometry per link, so the default stays a 2-vertex line.
  function linkCurvature(link: FGLink): number {
    if (isHugeGraph()) return 0;
    return isFocusedLink(link) ? getGraphSettings("3d").linkCurvature * 0.15 : 0;
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

  /**
   * Every node's scene object is just an invisible raycast proxy — the
   * visible star lives in the shared Points layer. Cached per node id so a
   * refresh() allocates nothing.
   */
  function nodeThreeObject(node: FGNode): Mesh {
    let proxy = proxyCache.get(node.id);
    if (!proxy) {
      proxy = new Mesh(NODE_PROXY_GEOMETRY, NODE_PROXY_MATERIAL);
      proxy.scale.setScalar(Math.max(2.4, nodeVisualRadius(node) * 1.5));
      proxyCache.set(node.id, proxy);
    }
    return proxy;
  }

  function configureForces(options: { reheat?: boolean } = {}): void {
    if (!graphEl) return;
    const cfg = getGraphSettings("3d");
    const budget = renderBudget();
    const dense = budget !== "normal";
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
          (node.isOrphan ? cfg.chargeStrengthOrphan * 0.75 : cfg.chargeStrength * 0.48) *
          chargeMultiplier,
      );
    graphEl.d3Force("charge")?.theta?.(chargeTheta);
    graphEl.d3Force("charge")?.distanceMax?.(chargeDistanceMax);
    graphEl.d3Force("center")?.strength?.(cfg.centerStrength);
    graphEl.d3Force("link")?.distance?.((link: FGLink) => {
      const sameFolder =
        isObjectNode(link.source) &&
        isObjectNode(link.target) &&
        link.source.clusterIndex === link.target.clusterIndex;
      return cfg.linkDistance * (sameFolder ? 0.9 : 1.4) * linkDistanceMultiplier;
    });
    graphEl.d3Force("link")?.strength?.((link: FGLink) => {
      const sameFolder =
        isObjectNode(link.source) &&
        isObjectNode(link.target) &&
        link.source.clusterIndex === link.target.clusterIndex;
      return Math.max(0, cfg.linkStrength) * (sameFolder ? 0.55 : 0.045) * (dense ? 0.7 : 1);
    });
    graphEl.d3Force("link")?.iterations?.(dense ? 1 : 2);

    // Universe layout force: clusters settle around anchors spread through a
    // 3D ball, orphans drift out to a sparse spherical shell around it. It
    // stays on for large/huge graphs (O(n) per tick, far cheaper than the
    // n·log n charge force) — only its strength drops.
    const clusters = graphState()?.clusters ?? [];
    if (clusters.length > 0) {
      const radius = galaxyRadius();
      const centers = constellationCenters(clusters.length, radius);
      const haloRadius = radius * GALAXY_HALO_RADIUS_RATIO;
      const budgetScale = budgetNumber(budget, {
        normal: 0.72,
        dense: 0.45,
        large: 0.4,
        huge: 0.3,
      });

      graphEl.d3Force("cluster", (alpha: number) => {
        const data = graphEl?.graphData();
        if (!data) return;
        const strength = cfg.clusterStrength * alpha * budgetScale;
        for (const node of data.nodes) {
          const x = node.x ?? 0;
          const y = node.y ?? 0;
          const z = node.z ?? 0;

          if (node.isOrphan) {
            // Lone stars: pushed radially out to a thin spherical shell.
            const r = Math.hypot(x, y, z) || 1;
            const haloStrength = strength * 0.5;
            node.vx = (node.vx ?? 0) + ((x / r) * haloRadius - x) * haloStrength;
            node.vy = (node.vy ?? 0) + ((y / r) * haloRadius - y) * haloStrength;
            node.vz = (node.vz ?? 0) + ((z / r) * haloRadius - z) * haloStrength;
            continue;
          }

          const center = centers.get(node.clusterIndex);
          if (!center) continue;
          // Hubs sink toward the cluster center: dense bright cores with
          // sparse outskirts, like a real star cluster's density profile.
          const pull = strength * (1 + Math.min(node.linkCount, 10) * 0.06);
          node.vx = (node.vx ?? 0) + (center.x - x) * pull;
          node.vy = (node.vy ?? 0) + (center.y - y) * pull;
          node.vz = (node.vz ?? 0) + (center.z - z) * pull;
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
    const target = (graphEl.controls() as { target: CameraPoint }).target;
    const dist = Math.max(1, Math.hypot(x - target.x, y - target.y, z - target.z));
    const nextZoom = Math.max(0.1, Math.min(8, 780 / dist));
    setZoomLevel(Math.round(nextZoom * 100) / 100);
  }

  function scheduleZoomFromCamera(): void {
    if (zoomFrame !== undefined) return;
    zoomFrame = requestAnimationFrame(() => {
      zoomFrame = undefined;
      updateZoomFromCamera();
    });
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

  function zoomBy(scale: number): void {
    if (!graphEl) return;
    const camera = graphEl.cameraPosition();
    const target = (graphEl.controls() as { target: CameraPoint }).target;
    smoothCameraTo(
      {
        x: target.x + (camera.x - target.x) * scale,
        y: target.y + (camera.y - target.y) * scale,
        z: target.z + (camera.z - target.z) * scale,
      },
      { ...target },
      300,
    );
  }

  function zoomIn(): void {
    zoomBy(0.8);
  }
  function zoomOut(): void {
    zoomBy(1.25);
  }

  function fitView(): void {
    if (!graphEl) return;
    const camera = graphEl.camera() as PerspectiveCamera;
    camera.updateMatrixWorld();
    graphObj?.updateWorldMatrix(true, false);
    const positions = graphEl
      .graphData()
      .nodes.filter(
        (node) => Number.isFinite(node.x) && Number.isFinite(node.y) && Number.isFinite(node.z),
      )
      .map((node) => {
        const point = new Vector3(node.x, node.y, node.z);
        return graphObj ? graphObj.localToWorld(point) : point;
      });
    if (!positions.length) return;
    const center = new Box3().setFromPoints(positions).getCenter(new Vector3());
    const right = new Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
    const up = new Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
    const back = new Vector3().setFromMatrixColumn(camera.matrixWorld, 2);
    const tangent = Math.tan((camera.fov * Math.PI) / 360);
    const { width, height } = dimensions();
    const padding = isCompact() ? 32 : 64;
    const availableX = Math.max(0.4, 1 - (2 * padding) / width);
    const availableY = Math.max(0.4, 1 - (2 * padding) / height);
    let distance = 220;
    for (const position of positions) {
      const relative = position.sub(center);
      distance = Math.max(
        distance,
        relative.dot(back) +
          Math.max(
            Math.abs(relative.dot(right)) / (tangent * camera.aspect * availableX),
            Math.abs(relative.dot(up)) / (tangent * availableY),
          ),
      );
    }
    const position = center.clone().addScaledVector(back, distance + 24);
    smoothCameraTo(position, center, 450);
  }

  function resetView(): void {
    if (!graphEl) return;
    cancelCameraAnimation();
    setSelectedNode(null);
    setHoveredNode(null);
    fitOnEngineStop = true;
    for (const node of graphEl.graphData().nodes) {
      node.fx = undefined;
      node.fy = undefined;
      node.fz = undefined;
    }
    galaxyAngle = 0;
    if (graphObj) graphObj.rotation.y = 0;
    smoothCameraTo(GALAXY_INITIAL_CAMERA, { x: 0, y: 0, z: 0 }, 500);
    graphEl.d3ReheatSimulation();
    setZoomLevel(1);
  }

  function locateNode(filePath: string): void {
    if (!graphEl) return;
    const node = graphEl.graphData().nodes.find((n) => n.filePath === filePath);
    if (node?.x === undefined || node.y === undefined || node.z === undefined) return;

    // Node coordinates are universe-local; the graph group spins around y, so
    // rotate into world space before aiming the camera.
    const ca = Math.cos(galaxyAngle);
    const sa = Math.sin(galaxyAngle);
    const wx = node.x * ca + node.z * sa;
    const wy = node.y;
    const wz = -node.x * sa + node.z * ca;

    const currentCamera = graphEl.cameraPosition();
    const dx = currentCamera.x - wx;
    const dy = currentCamera.y - wy;
    const dz = currentCamera.z - wz;
    const len = Math.hypot(dx, dy, dz) || 1;
    const dist = Math.max(220, nodeRadius(node) * 18 + 150);
    const camera = {
      x: wx + (dx / len) * dist,
      y: wy + (dy / len) * dist,
      z: wz + (dz / len) * dist,
    };
    setHoveredNode(null);
    setSelectedNode(filePath);
    lastLocateAt = performance.now();
    smoothCameraTo(camera, { x: wx, y: wy, z: wz });
    setZoomLevel(Math.max(0.1, Math.min(8, 780 / dist)));
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
        .nodeLabel(() => "")
        .nodeVal((node) => Math.max(2, nodeRadius(node)))
        .nodeThreeObject((node) => nodeThreeObject(node))
        .nodeRelSize(GRAPH_3D_NODE_REL_SIZE)
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
        .linkDirectionalParticles(0)
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
        .enableNavigationControls(true)
        .onEngineTick(() => syncStarPositions())
        .onEngineStop(() => {
          syncStarPositions();
          if (fitOnEngineStop && instance.graphData().nodes.length > 0) {
            fitOnEngineStop = false;
            fitView();
          }
        });

      graphEl = instance;
      instance
        .renderer()
        .setPixelRatio(isDenseGraph() ? 1 : Math.min(window.devicePixelRatio, 1.5));
      const controls = instance.controls() as OrbitControls;
      controls.zoomSpeed = GRAPH_3D_SCROLL_ZOOM_SPEED;
      controls.rotateSpeed = 0.65;
      controls.panSpeed = 0.85;
      controls.minDistance = 30;
      controls.maxDistance = 100_000;
      removeTrackpadControls = attachGraphTrackpadControls(
        instance.renderer().domElement,
        instance.camera() as PerspectiveCamera,
        controls,
        () => {
          cancelCameraAnimation();
          fitOnEngineStop = false;
          lastControlInteractionAt = performance.now();
        },
      );
      const handleControlsChange = () => {
        lastControlInteractionAt = performance.now();
        scheduleZoomFromCamera();
      };
      controls.addEventListener?.("change", handleControlsChange);
      removeControlsChangeListener = () => {
        controls.removeEventListener?.("change", handleControlsChange);
      };

      // The ThreeForceGraph group is the scene child exposing graphData();
      // it carries both document points and labels during the slow rotation.
      graphObj = instance
        .scene()
        .children.find(
          (child): child is Group =>
            child instanceof Group &&
            typeof (child as unknown as { graphData?: unknown }).graphData === "function",
        );

      const rect = hostEl.getBoundingClientRect();
      setDimensions({ width: rect.width, height: rect.height });
      instance.width(rect.width).height(rect.height);
      // An open overview; initial settling then fits the actual document bounds.
      instance.cameraPosition(GALAXY_INITIAL_CAMERA, { x: 0, y: 0, z: 0 }, 0);
      buildScenery();
      startSceneryLoop();

      resizeObs = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const { width, height } = entry.contentRect;
          setDimensions({ width, height });
          graphEl?.width(Math.max(1, Math.floor(width))).height(Math.max(1, Math.floor(height)));
          updateLabels();
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
        if (!s || s.nodes.length === 0) {
          if (dataFrame !== undefined) cancelAnimationFrame(dataFrame);
          dataFrame = undefined;
          graphEl.graphData({ nodes: [], links: [] });
          disposeNodeStars();
          clearLabels();
          return;
        }

        const previous = new Map(graphEl.graphData().nodes.map((node) => [node.id, node]));
        const nodes: FGNode[] = s.nodes.map((n) => {
          const old = previous.get(n.id);
          return { ...n, x: old?.x, y: old?.y, z: old?.z };
        });
        seedConstellation(
          nodes,
          constellationCenters(s.clusters.length, galaxyRadius()),
          galaxyRadius(),
        );
        const links: FGLink[] = s.links.map((l) => ({ ...l }));
        proxyCache.clear();
        clearLabels();
        graphEl.graphData({ nodes, links });
        graphEl.linkVisibility((link) => linkVisible(link));
        graphEl
          .renderer()
          .setPixelRatio(isDenseGraph() ? 1 : Math.min(window.devicePixelRatio, 1.5));
        if (starfield) {
          const uPixelRatio = (starfield.material as ShaderMaterial).uniforms.uPixelRatio;
          if (uPixelRatio) uPixelRatio.value = graphEl.renderer().getPixelRatio();
        }

        if (dataFrame !== undefined) cancelAnimationFrame(dataFrame);
        dataFrame = requestAnimationFrame(() => {
          dataFrame = undefined;
          configureForces();
          buildNodeStars();
          updateLabels();
        });
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
        // Node sizing settings feed the star buffer and proxy scales.
        proxyCache.clear();
        updateStarVisuals();
        updateLabels();
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
      () => [hoveredNode(), selectedNode(), currentFilePath(), zoomLevel()] as const,
      () => {
        if (!graphEl) return;
        // Stars and labels update via buffers/pools; refresh() only needs to
        // re-evaluate link materials (highlight colors/widths).
        updateStarVisuals();
        updateLabels();
        graphEl.linkVisibility((link) => linkVisible(link));
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
        parsedColorCache.clear();
        // Blending modes differ per theme, so both Points layers must be
        // rebuilt — not just retinted.
        buildScenery();
        buildNodeStars();
        clearLabels();
        updateLabels();
        graphEl?.refresh();
      },
      { defer: true },
    ),
  );

  createEffect(
    on(
      () => [settingsState.editor.fontFamily, currentLocale()] as const,
      () => {
        cssVarCache.delete("--font-editor");
        updateLabels();
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
    if (dataFrame !== undefined) cancelAnimationFrame(dataFrame);
    stopSceneryLoop();
    removeTrackpadControls?.();
    removeTrackpadControls = undefined;
    removeControlsChangeListener?.();
    removeControlsChangeListener = undefined;
    if (zoomFrame !== undefined) {
      cancelAnimationFrame(zoomFrame);
      zoomFrame = undefined;
    }
    disposeScenery();
    disposeNodeStars();
    clearLabels();
    labelGroup = undefined;
    proxyCache.clear();
    parsedColorCache.clear();
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
      data-kuku-constellation-canvas="true"
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
        <Show when={!isCompact()}>
          <p class="pointer-events-none absolute top-4 left-6 max-w-[70%] text-[0.6875rem] text-text-secondary">
            {t("graph.ctrl.trackpad_hint")}
          </p>
        </Show>
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
      aria-label={props.title}
      aria-pressed={props.active}
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
