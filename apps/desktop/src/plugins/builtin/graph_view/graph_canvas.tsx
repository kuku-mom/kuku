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

import { getGraphStore } from "./graph_store";
import {
  clusterBgColor,
  clusterColor,
  getGraphSummary,
  type FGLink,
  type FGNode,
  type GraphCanvasHandle,
  type GraphNode,
  type GraphVariant,
} from "./graph_types";

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
  let isFirstDataLoad = true;

  // ── Signals (UI state that drives JSX re-renders) ──────────

  const [initError, setInitError] = createSignal<string | null>(null);
  const [hoveredNode, setHoveredNode] = createSignal<FGNode | null>(null);
  const [selectedNode, setSelectedNode] = createSignal<string | null>(null);
  const [zoomLevel, setZoomLevel] = createSignal(1);
  const [showClusters, setShowClusters] = createSignal(true);
  const [followMode, setFollowMode] = createSignal(false);
  const [dimensions, setDimensions] = createSignal({ width: 400, height: 300 });

  // ── Derived State ──────────────────────────────────────────

  const store = createMemo(() => getGraphStore());
  const isCompact = () => props.variant === "compact";
  const currentFilePath = () => props.currentFilePath ?? null;

  const connectedToHovered = createMemo(() => {
    const node = hoveredNode();
    if (!node) return new Set<string>();
    const s = store()?.state;
    if (!s) return new Set<string>();
    return new Set(s.adjacencyMap[node.filePath]);
  });

  const status = createMemo((): "loading" | "error" | "empty" | "ready" => {
    const s = store()?.state;
    if (!s || s.isIndexing) return "loading";
    if (s.error) return "error";
    if (s.nodes.length === 0) return "empty";
    return "ready";
  });

  const summary = createMemo(() => getGraphSummary(store()?.state ?? null));

  // ── Theme helpers for Canvas2D ─────────────────────────────

  /** Resolve a CSS custom property from the host element (e.g. `--color-bg-primary`). */
  function cssVar(name: string, fallback = ""): string {
    if (!hostEl) return fallback;
    return getComputedStyle(hostEl).getPropertyValue(name).trim() || fallback;
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

  function paintClusterBackgrounds(ctx: CanvasRenderingContext2D, globalScale: number): void {
    if (!showClusters() || globalScale > 2.5) return;

    const s = store()?.state;
    const groups = getClusterGroups();

    for (const [clusterIdx, nodes] of groups) {
      const points = nodes
        .filter((n) => n.x !== undefined && n.y !== undefined)
        .map((n) => ({ x: n.x ?? 0, y: n.y ?? 0 }));

      if (points.length < 1) continue;

      const pad = 50 / globalScale;

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
      ctx.fill();

      ctx.strokeStyle = clusterColor(clusterIdx, 0.25);
      ctx.lineWidth = 1.2 / globalScale;
      ctx.stroke();

      if (globalScale < 1.5 && !isCompact()) {
        const centX = points.reduce((sum, p) => sum + p.x, 0) / points.length;
        const minY = Math.min(...points.map((p) => p.y));

        const fontSize = Math.max(9, Math.min(13, 11 / globalScale));
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

        ctx.fillStyle = clusterColor(clusterIdx);
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
    const isConnected = connectedToHovered().has(node.filePath);

    const baseSize = node.isOrphan ? 4 : Math.max(3.5, Math.min(11, 3.5 + node.linkCount * 0.7));
    let size = baseSize;
    if (isSelected || isHovered) size = baseSize * 1.3;
    else if (isConnected) size = baseSize * 1.15;

    const nodeClusterColor = clusterColor(node.clusterIndex);
    let fillColor = nodeClusterColor;
    if (node.isOrphan) fillColor = "#6b7280";
    else if (isCurrent) fillColor = "#8b5cf6";
    else if (isSelected) fillColor = "#3b82f6";

    if (isSelected || isHovered || isCurrent || isConnected) {
      ctx.beginPath();
      ctx.arc(x, y, size + 3.5, 0, 2 * Math.PI);
      ctx.globalAlpha = isConnected && !isHovered ? 0.27 : 0.19;
      ctx.fillStyle = fillColor;
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    ctx.beginPath();
    ctx.arc(x, y, size, 0, 2 * Math.PI);
    ctx.fillStyle = fillColor;
    ctx.fill();

    if (isSelected || isCurrent) {
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1.8;
    } else if (isConnected) {
      ctx.strokeStyle = "rgba(255,255,255,0.6)";
      ctx.lineWidth = 1.2;
    } else {
      ctx.strokeStyle = "rgba(255,255,255,0.3)";
      ctx.lineWidth = 0.8;
    }
    ctx.stroke();

    const showLabel = (isSelected || isCurrent || isConnected || globalScale > 2) && !isHovered;
    if (showLabel) {
      let baseFontSize = 8;
      if (isSelected || isCurrent) baseFontSize = 10;
      else if (isConnected) baseFontSize = 9;
      const fontSize = Math.max(6, Math.min(baseFontSize, baseFontSize / globalScale ** 0.3));
      ctx.font = `${isConnected ? 500 : 400} ${fontSize}px -apple-system, BlinkMacSystemFont, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";

      let maxLen = 10;
      if (globalScale > 3) maxLen = 20;
      else if (globalScale > 2) maxLen = 14;
      else if (isConnected) maxLen = 12;
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

      ctx.globalAlpha = 0.45;
      ctx.fillStyle = clusterColor(node.clusterIndex);
      ctx.fillText(label, x, labelY);
      ctx.globalAlpha = 1;
    }
  }

  function getLinkColor(link: FGLink): string {
    const sourceId = typeof link.source === "object" ? link.source.id : link.source;
    const targetId = typeof link.target === "object" ? link.target.id : link.target;
    const sourceNode = typeof link.source === "object" ? link.source : null;

    const sel = selectedNode();
    if (sel && (sourceId === sel || targetId === sel)) return "rgba(59, 130, 246, 0.75)";

    const cur = currentFilePath();
    if (cur && (sourceId === cur || targetId === cur)) return "rgba(139, 92, 246, 0.75)";

    const hov = hoveredNode();
    if (hov && (sourceId === hov.filePath || targetId === hov.filePath) && sourceNode) {
      return clusterColor(sourceNode.clusterIndex, 0.63);
    }

    if (sourceNode) return clusterColor(sourceNode.clusterIndex, 0.21);

    return "rgba(107, 114, 128, 0.25)";
  }

  function getLinkWidth(link: FGLink): number {
    const sourceId = typeof link.source === "object" ? link.source.id : link.source;
    const targetId = typeof link.target === "object" ? link.target.id : link.target;

    const sel = selectedNode();
    if (sel && (sourceId === sel || targetId === sel)) return 2;

    const cur = currentFilePath();
    if (cur && (sourceId === cur || targetId === cur)) return 2;

    const hov = hoveredNode();
    if (hov && (sourceId === hov.filePath || targetId === hov.filePath)) return 1.5;

    return 0.8;
  }

  // ── Force Configuration ───────────────────────────────────

  function configureForces(): void {
    if (!graphEl) return;

    const s = store()?.state;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (graphEl.d3Force("charge") as any)?.strength((node: FGNode) => (node.isOrphan ? -80 : -200));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (graphEl.d3Force("link") as any)?.distance((link: FGLink) => {
      const source = typeof link.source === "object" ? link.source : null;
      const target = typeof link.target === "object" ? link.target : null;
      if (source && target && source.folder === target.folder) return 50;
      return 180;
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (graphEl.d3Force("center") as any)?.strength(0.03);

    const clusters = s?.clusters ?? [];
    if (clusters.length > 1) {
      const { width, height } = dimensions();
      const clusterRadius = Math.min(width, height) * 0.4;
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
          const strength = 0.25 * alpha;
          node.vx = (node.vx ?? 0) + (center.x - (node.x ?? 0)) * strength;
          node.vy = (node.vy ?? 0) + (center.y - (node.y ?? 0)) * strength;
        }
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (graphEl as any).d3Force("cluster", clusterForce);
    }

    graphEl.d3ReheatSimulation();
  }

  // ── Zoom Controls ─────────────────────────────────────────

  function zoomIn(): void {
    if (!graphEl) return;
    const next = Math.min(8, graphEl.zoom() * 1.3);
    graphEl.zoom(next, 300);
    setZoomLevel(next);
  }

  function zoomOut(): void {
    if (!graphEl) return;
    const next = Math.max(0.1, graphEl.zoom() / 1.3);
    graphEl.zoom(next, 300);
    setZoomLevel(next);
  }

  function fitView(): void {
    if (!graphEl) return;
    graphEl.zoomToFit(300, 60);
    setTimeout(() => {
      if (graphEl) setZoomLevel(graphEl.zoom());
    }, 350);
  }

  function resetView(): void {
    if (!graphEl) return;
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
    const data = graphEl.graphData() as unknown as { nodes: FGNode[] };
    const node = data.nodes.find((n) => n.filePath === filePath);
    if (node?.x !== undefined && node?.y !== undefined) {
      graphEl.centerAt(node.x, node.y, 500);
      graphEl.zoom(2, 500);
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
    if (node.__dragStartX === undefined) {
      node.__dragStartX = node.x;
      node.__dragStartY = node.y;
      dragDistance = 0;
    }
    const dx = (node.x ?? 0) - (node.__dragStartX ?? 0);
    const dy = (node.y ?? 0) - (node.__dragStartY ?? 0);
    dragDistance = Math.sqrt(dx * dx + dy * dy);
  }

  function handleNodeDragEnd(node: FGNode): void {
    if (dragDistance > 5) {
      node.fx = node.x;
      node.fy = node.y;
    }
    node.__dragStartX = undefined;
    node.__dragStartY = undefined;
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
          const baseSize = Math.max(3.5, Math.min(11, 3.5 + n.linkCount * 0.7));
          const hitArea = Math.max(12, baseSize + 6);
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(n.x ?? 0, n.y ?? 0, hitArea, 0, 2 * Math.PI);
          ctx.fill();
        })
        .linkColor((link) => getLinkColor(link as FGLink))
        .linkWidth((link) => getLinkWidth(link as FGLink))
        .linkDirectionalArrowLength(3)
        .linkDirectionalArrowRelPos(0.9)
        .linkCurvature(0.12)
        .onNodeClick((node) => handleNodeClick(node as FGNode))
        .onNodeHover((node) => setHoveredNode((node as FGNode) ?? null))
        .onNodeDrag((node) => handleNodeDrag(node as FGNode))
        .onNodeDragEnd((node) => handleNodeDragEnd(node as FGNode))
        .onBackgroundClick(() => {
          setSelectedNode(null);
          props.onBackgroundClick?.();
        })
        .onRenderFramePre((ctx, globalScale) => paintClusterBackgrounds(ctx, globalScale))
        .onZoom(({ k }) => setZoomLevel(k))
        .backgroundColor("transparent")
        .d3AlphaDecay(0.01)
        .d3VelocityDecay(0.3)
        .warmupTicks(80)
        .cooldownTicks(300)
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

        if (isFirstDataLoad) {
          isFirstDataLoad = false;
          setTimeout(() => {
            graphEl?.zoomToFit(400, 40);
            setTimeout(() => {
              if (graphEl) setZoomLevel(graphEl.zoom());
            }, 450);
          }, 500);
        }
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

  // ── Cleanup ───────────────────────────────────────────────
  //
  // Mirrors kuku-oss: pause, manually remove canvas children,
  // then clear the plain variable. No `_destructor()` — calling
  // it sets Kapsule's internal domNode = null, which can race
  // with in-flight rAF callbacks and crash.

  onCleanup(() => {
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
      class={`relative min-h-0 min-w-0 flex-1 overflow-hidden bg-linear-to-br from-bg-secondary via-bg-primary to-bg-secondary ${
        props.class ?? ""
      }`}
    >
      {/* Canvas host — ForceGraph appends its <canvas> here */}
      <div ref={hostEl} class="absolute inset-0" />

      {/* Status overlay */}
      <Show when={status() !== "ready" || initError()}>
        <div class="absolute inset-0 flex items-center justify-center p-6">
          <div class="max-w-sm rounded-xs border border-border/70 bg-bg-primary/90 px-5 py-4 text-center shadow-lg backdrop-blur-sm">
            <Show when={initError()}>
              <p class="text-sm text-text-secondary">{initError()}</p>
            </Show>

            <Show when={!initError() && status() === "loading"}>
              <div class="space-y-2">
                <div class="mx-auto h-2.5 w-24 animate-pulse rounded-xs bg-ghost-hover" />
                <p class="text-sm text-text-secondary">Indexing graph data…</p>
              </div>
            </Show>

            <Show when={!initError() && status() === "error"}>
              <p class="text-sm text-text-secondary">
                {store()?.state.error ?? "Unknown graph error"}
              </p>
            </Show>

            <Show when={!initError() && status() === "empty"}>
              <div class="space-y-2">
                <p class="text-sm text-text-secondary">No graph data yet.</p>
                <p class="text-xs text-text-muted">
                  Open a vault and let the graph index markdown links.
                </p>
              </div>
            </Show>

            <div class="mt-4 flex items-center justify-center gap-3 text-[0.6875rem] text-text-muted">
              <span>{summary().nodeCount} nodes</span>
              <span>{summary().linkCount} links</span>
            </div>
          </div>
        </div>
      </Show>

      {/* Zoom & view controls */}
      <Show when={status() === "ready"}>
        <div
          class="absolute right-3 bottom-3 flex items-center gap-1 rounded-xs border border-border/70 bg-bg-primary/80 p-1 shadow-md backdrop-blur-sm"
          classList={{ "right-2! bottom-2! p-0.5!": isCompact() }}
        >
          <CtrlBtn title="Zoom in" onClick={zoomIn}>
            <ZoomInIcon />
          </CtrlBtn>
          <CtrlBtn title="Zoom out" onClick={zoomOut}>
            <ZoomOutIcon />
          </CtrlBtn>

          <Show when={!isCompact()}>
            <div class="mx-0.5 h-4 w-px bg-border/50" />
            <CtrlBtn
              title="Toggle clusters"
              onClick={() => setShowClusters(!showClusters())}
              active={showClusters()}
            >
              <ClustersIcon />
            </CtrlBtn>
          </Show>

          <CtrlBtn title="Fit all nodes" onClick={fitView}>
            <FitViewIcon />
          </CtrlBtn>

          <Show when={isCompact()}>
            <CtrlBtn
              title={followMode() ? "Stop following current note" : "Follow current note"}
              onClick={() => {
                const next = !followMode();
                setFollowMode(next);
                if (next) {
                  const fp = currentFilePath();
                  if (fp) locateNode(fp);
                }
              }}
              active={followMode()}
            >
              <LocateIcon />
            </CtrlBtn>
          </Show>

          <Show when={!isCompact()}>
            <CtrlBtn title="Reset view" onClick={resetView}>
              <ResetViewIcon />
            </CtrlBtn>
          </Show>

          <span class="px-1.5 text-[0.6rem] text-text-muted tabular-nums">
            {Math.round(zoomLevel() * 100)}%
          </span>
        </div>
      </Show>

      {/* Tooltip on hover */}
      <Show when={hoveredNode()}>
        {(node) => (
          <div class="pointer-events-none absolute bottom-12 left-3 max-w-56 rounded-xs border border-border/70 bg-bg-primary/90 px-3 py-2 shadow-lg backdrop-blur-sm">
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
                <span class="rounded-xs bg-ghost-hover px-1.5 py-0.5 text-[0.625rem]">orphan</span>
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
  children: JSX.Element;
}): JSX.Element {
  return (
    <button
      type="button"
      title={props.title}
      class="flex size-6 cursor-pointer items-center justify-center rounded-xs border-none bg-transparent text-[0.75rem] text-text-muted transition-colors hover:bg-ghost-hover hover:text-text-primary"
      classList={{ "bg-ghost-hover! text-text-primary!": props.active }}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}
