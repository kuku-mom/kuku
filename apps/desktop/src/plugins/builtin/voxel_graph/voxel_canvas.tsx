// ── Agent World Canvas ──
//
// Hosts the agent world: a voxel archipelago where every vault folder is an
// island, every note is a house with a resident agent, and wikilinks are
// bridges and glowing pulses. The world engine (./world) owns the scene
// content; this component owns the renderer, camera, input, and overlay UI.

import {
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
  Show,
  type JSX,
} from "solid-js";
import {
  Color,
  FogExp2,
  MOUSE,
  PerspectiveCamera,
  Raycaster,
  Scene,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import {
  FitViewIcon,
  LocateIcon,
  ResetViewIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from "~/components/icons";
import { t, tf } from "~/i18n";
import {
  getGraphSummary,
  type GraphNode,
  type GraphVariant,
} from "~/plugins/builtin/graph_view/graph_types";
import { getEffectiveTheme } from "~/stores/theme";

import { agentWorldRestoreKey, clamp, getVoxelVisibleStats, shortLabel } from "./voxel_layout";
import { getVoxelRenderSettings } from "./voxel_settings";
import { getVoxelGraphStore } from "./voxel_store";
import { classForNode, type AgentClass } from "./world/agents";
import { createAgentWorld, type AgentWorldEngine } from "./world/engine";
import { retainWorldModelResources } from "./world/model_resources";
import { paletteForMood, type WorldMood } from "./world/palette";
import { PainterlyRenderer } from "./world/postfx";

const JOB_LABEL_KEYS = {
  knight: "voxel_graph.tooltip.job.knight",
  wizard: "voxel_graph.tooltip.job.wizard",
  ranger: "voxel_graph.tooltip.job.ranger",
  noble: "voxel_graph.tooltip.job.noble",
  peasant: "voxel_graph.tooltip.job.peasant",
  villager: "voxel_graph.tooltip.job.villager",
} as const satisfies Record<AgentClass, string>;

interface VoxelCanvasProps {
  variant: GraphVariant;
  currentFilePath?: string | null;
  onNodeClick?: (node: GraphNode) => void;
  initialFollowMode?: boolean;
  class?: string;
}

interface CameraTween {
  fromPosition: Vector3;
  toPosition: Vector3;
  fromTarget: Vector3;
  toTarget: Vector3;
  startedAt: number;
  duration: number;
}

const MIN_POLAR = Math.PI * 0.18;
// Cap the tilt to a comfortable bird's-eye 3/4 angle (~33° above horizontal).
// Any flatter and the camera grazes to eye level, looking across the waterline
// and *through* house walls / under the floating islands into the grey backdrop.
const MAX_POLAR = Math.PI * 0.33;
// Orbit/look-at pivots at island height, not the waterline, so low angles still
// look at the village from above instead of up at the island undersides.
const VIEW_TARGET_Y = 7;
// Camera eye never drops below this height — above the tallest island surface so
// the view stays on top of the world, never inside/under it.
const CAMERA_MIN_Y = 16;
const PICK_INTERVAL_MS = 70;
const ISO_DIRECTION = new Vector3(1, 1.05, 1).normalize();

function easeInOutCubic(progress: number): number {
  return progress < 0.5 ? 4 * progress ** 3 : 1 - (-2 * progress + 2) ** 3 / 2;
}

export default function VoxelCanvas(props: VoxelCanvasProps): JSX.Element {
  let hostEl: HTMLDivElement | undefined;
  let renderer: WebGLRenderer | undefined;
  let scene: Scene | undefined;
  let camera: PerspectiveCamera | undefined;
  let controls: OrbitControls | undefined;
  let engine: AgentWorldEngine | undefined;
  let releaseModelResources: (() => void) | undefined;
  let painterly: PainterlyRenderer | undefined;
  let resizeObs: ResizeObserver | undefined;
  let animationFrame: number | undefined;
  let lastFrameAt = 0;
  let lastPickAt = 0;
  let restoreKey: string | null = null;
  let pointerInside = false;
  let pointerDirty = false;
  let pointerDown: { x: number; y: number; at: number } | null = null;
  let cameraTween: CameraTween | null = null;

  const raycaster = new Raycaster();
  const pointer = new Vector2();

  const [initError, setInitError] = createSignal<string | null>(null);
  const [hoveredNode, setHoveredNode] = createSignal<GraphNode | null>(null);
  const [selectedPath, setSelectedPath] = createSignal<string | null>(null);
  const [followMode, setFollowMode] = createSignal(props.initialFollowMode ?? false);
  const [zoomLevel, setZoomLevel] = createSignal(1);

  const store = createMemo(() => getVoxelGraphStore());
  const graphState = createMemo(() => store()?.state ?? null);
  const summary = createMemo(() => getGraphSummary(graphState()));
  const visibleStats = createMemo(() => getVoxelVisibleStats(graphState()));
  const currentFilePath = () => props.currentFilePath ?? null;
  const isCompact = () => props.variant === "compact";

  const status = createMemo((): "loading" | "error" | "empty" | "ready" => {
    const state = graphState();
    if (!state || state.isIndexing) return "loading";
    if (state.error) return "error";
    if (state.nodes.length === 0) return "empty";
    return "ready";
  });

  const hoveredConnections = createMemo(() => {
    const node = hoveredNode();
    const state = graphState();
    if (!node || !state) return 0;
    return state.adjacencyMap[node.filePath]?.length ?? 0;
  });

  // ── Camera helpers ──

  function fitDistance(): number {
    // Initial/fit framing: close enough that islands fill the view.
    return Math.max(180, (engine?.worldRadius ?? 200) * 1.4);
  }

  function updateZoomFromCamera(): void {
    if (!camera || !controls) return;
    setZoomLevel(fitDistance() / Math.max(1, camera.position.distanceTo(controls.target)));
  }

  function applyCameraLimits(): void {
    if (!camera || !controls || !engine) return;
    const radius = engine.worldRadius;
    camera.near = 4;
    camera.far = Math.max(radius * 8, 6_000);
    camera.updateProjectionMatrix();
    controls.minDistance = isCompact() ? radius * 0.12 : radius * 0.1;
    // Cap zoom-out just past the fit distance — no drifting into empty sky.
    controls.maxDistance = Math.max(fitDistance() * 1.25, radius * 1.6);
  }

  function tweenCameraTo(targetPoint: Vector3, distance: number, duration = 650): void {
    if (!camera || !controls) return;
    cameraTween = {
      fromPosition: camera.position.clone(),
      toPosition: targetPoint.clone().add(ISO_DIRECTION.clone().multiplyScalar(distance)),
      fromTarget: controls.target.clone(),
      toTarget: targetPoint.clone(),
      startedAt: performance.now(),
      duration,
    };
  }

  function fitView(animated = true): void {
    const target = new Vector3(0, VIEW_TARGET_Y, 0);
    if (animated) tweenCameraTo(target, fitDistance());
    else {
      controls?.target.copy(target);
      camera?.position.copy(ISO_DIRECTION.clone().multiplyScalar(fitDistance()));
      controls?.update();
    }
    updateZoomFromCamera();
  }

  function resetView(): void {
    setSelectedPath(null);
    setFollowMode(false);
    engine?.setSelected(null);
    fitView();
  }

  function zoomBy(factor: number): void {
    if (!camera || !controls) return;
    cameraTween = null;
    const offset = camera.position.clone().sub(controls.target).multiplyScalar(factor);
    const length = clamp(offset.length(), controls.minDistance, controls.maxDistance);
    camera.position.copy(controls.target.clone().add(offset.setLength(length)));
    controls.update();
    updateZoomFromCamera();
  }

  function locateCurrent(): void {
    const filePath = currentFilePath();
    if (!filePath || !engine) return;
    const anchor = engine.anchorFor(filePath);
    // Close-up: frame the house and its resident, not the whole island.
    if (anchor) tweenCameraTo(anchor, Math.max(78, engine.worldRadius * 0.16));
  }

  // ── World lifecycle ──

  function rebuildWorld(): void {
    if (!scene) return;
    setInitError(null);
    const state = graphState();
    const previousRadius = engine?.worldRadius ?? null;
    const nextRestoreKey = state && state.nodes.length > 0 ? agentWorldRestoreKey(state) : null;
    // Carry agent positions/journeys over so theme switches and graph updates
    // never teleport the characters. If graph layout or routes changed, let
    // agents respawn at the new houses instead of restoring stale world coords.
    const restoreAgents =
      restoreKey !== null && restoreKey === nextRestoreKey ? engine?.agentSnapshot() : undefined;

    if (engine) {
      scene.remove(engine.group);
      engine.dispose();
      engine = undefined;
    }
    if (!state || state.nodes.length === 0) {
      restoreKey = null;
      return;
    }

    const mood: WorldMood = getEffectiveTheme() === "dark" ? "night" : "day";
    try {
      engine = createAgentWorld({
        nodes: state.nodes,
        links: state.links,
        adjacencyMap: state.adjacencyMap,
        clusters: state.clusters,
        mood,
        compact: isCompact(),
        renderSettings: { ...getVoxelRenderSettings() },
        restoreAgents,
      });
    } catch (error) {
      setInitError(error instanceof Error ? error.message : String(error));
      return;
    }

    scene.add(engine.group);
    restoreKey = nextRestoreKey;
    scene.fog = new FogExp2(engine.palette.fog, engine.palette.fogDensity);
    scene.background = new Color(engine.palette.fog);
    engine.setFocus(currentFilePath(), followMode());
    engine.setSelected(selectedPath());
    applyCameraLimits();

    // Refit only when the world meaningfully changed size, so theme toggles
    // and incremental graph updates keep the player's viewpoint.
    if (previousRadius === null || Math.abs(previousRadius - engine.worldRadius) > 60) {
      fitView(previousRadius !== null);
    }
  }

  // ── Picking ──

  function pickAtPointer(): GraphNode | null {
    if (!camera || !engine || !pointerInside) return null;
    raycaster.setFromCamera(pointer, camera);
    return engine.pick(raycaster);
  }

  function handlePointerMove(event: PointerEvent): void {
    if (!hostEl) return;
    const rect = hostEl.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -(((event.clientY - rect.top) / rect.height) * 2 - 1);
    pointerInside = true;
    pointerDirty = true;
  }

  function handlePointerLeave(): void {
    pointerInside = false;
    setHoveredNode(null);
    engine?.setHovered(null);
  }

  function handleKeyDown(event: KeyboardEvent): void {
    if (event.key !== "Escape") return;
    if (!selectedPath() && !followMode()) return;
    setSelectedPath(null);
    setFollowMode(false);
    engine?.setSelected(null);
  }

  function handlePointerDown(event: PointerEvent): void {
    // Only the main button selects nodes; middle/right drags move the camera.
    if (event.button !== 0) return;
    pointerDown = { x: event.clientX, y: event.clientY, at: performance.now() };
  }

  function handlePointerUp(event: PointerEvent): void {
    const start = pointerDown;
    pointerDown = null;
    if (!start || event.button !== 0) return;
    const wasDrag =
      Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5 ||
      performance.now() - start.at > 450;
    if (wasDrag) return;

    handlePointerMove(event);
    const node = pickAtPointer();
    if (node) {
      setSelectedPath(node.filePath);
      engine?.setSelected(node.filePath);
      props.onNodeClick?.(node);
    } else {
      setSelectedPath(null);
      engine?.setSelected(null);
    }
  }

  // ── Frame loop ──

  function frame(now: number): void {
    animationFrame = requestAnimationFrame(frame);
    if (!renderer || !scene || !camera || !controls) return;
    const delta = lastFrameAt === 0 ? 0.016 : (now - lastFrameAt) / 1000;
    lastFrameAt = now;

    // Camera tween
    if (cameraTween) {
      const progress = clamp((now - cameraTween.startedAt) / cameraTween.duration, 0, 1);
      const eased = easeInOutCubic(progress);
      camera.position.lerpVectors(cameraTween.fromPosition, cameraTween.toPosition, eased);
      controls.target.lerpVectors(cameraTween.fromTarget, cameraTween.toTarget, eased);
      if (progress >= 1) cameraTween = null;
      updateZoomFromCamera();
    }

    // Follow the current note's agent.
    if (followMode() && !cameraTween && engine) {
      const filePath = currentFilePath();
      const anchor = filePath ? engine.anchorFor(filePath) : null;
      if (anchor) {
        const shift = anchor.sub(controls.target).multiplyScalar(Math.min(1, delta * 3.2));
        controls.target.add(shift);
        camera.position.add(shift);
      }
    }

    // Hover picking, throttled.
    if (pointerDirty && now - lastPickAt > PICK_INTERVAL_MS && !pointerDown) {
      lastPickAt = now;
      pointerDirty = false;
      const node = pickAtPointer();
      setHoveredNode(node);
      engine?.setHovered(node?.filePath ?? null);
      if (hostEl) hostEl.style.cursor = node ? "pointer" : "default";
    }

    engine?.update(now / 1000, delta);
    controls.update();
    // Keep the look-at point over the world so panning can't drift the camera
    // off the edge into the empty backdrop.
    if (engine) {
      const maxR = engine.worldRadius * 1.05;
      controls.target.x = clamp(controls.target.x, -maxR, maxR);
      controls.target.z = clamp(controls.target.z, -maxR, maxR);
      controls.target.y = clamp(controls.target.y, 4, 26);
      // Hard floor on camera height so tweens/follow can never dip the eye below
      // the islands (which would reveal grey undersides / house interiors).
      if (camera.position.y < CAMERA_MIN_Y) camera.position.y = CAMERA_MIN_Y;
    }
    if (painterly) painterly.render(scene, camera);
    else renderer.render(scene, camera);
  }

  // ── Mount ──

  onMount(() => {
    if (!hostEl) return;
    releaseModelResources = retainWorldModelResources();
    try {
      renderer = new WebGLRenderer({ antialias: true });
      renderer.outputColorSpace = SRGBColorSpace;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
      painterly = new PainterlyRenderer(renderer, [0.13, 0.12, 0.1]);
    } catch (error) {
      setInitError(error instanceof Error ? error.message : String(error));
      return;
    }

    scene = new Scene();
    // Match the sky before the first world build so loading never flashes black.
    scene.background = new Color(
      paletteForMood(getEffectiveTheme() === "dark" ? "night" : "day").fog,
    );
    camera = new PerspectiveCamera(50, 1, 4, 8_000);
    camera.position.copy(ISO_DIRECTION.clone().multiplyScalar(900));

    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.085;
    controls.minPolarAngle = MIN_POLAR;
    controls.maxPolarAngle = MAX_POLAR;
    controls.enablePan = true;
    controls.screenSpacePanning = false;
    // Left drag orbits, middle or right drag pans the view.
    controls.mouseButtons = { LEFT: MOUSE.ROTATE, MIDDLE: MOUSE.PAN, RIGHT: MOUSE.PAN };
    controls.addEventListener("change", updateZoomFromCamera);
    controls.addEventListener("start", () => {
      cameraTween = null;
    });

    hostEl.appendChild(renderer.domElement);
    hostEl.addEventListener("pointermove", handlePointerMove);
    hostEl.addEventListener("pointerleave", handlePointerLeave);
    hostEl.addEventListener("pointerdown", handlePointerDown);
    hostEl.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("keydown", handleKeyDown);

    resizeObs = new ResizeObserver(() => {
      if (!hostEl || !renderer || !camera) return;
      const { clientWidth, clientHeight } = hostEl;
      if (clientWidth === 0 || clientHeight === 0) return;
      if (painterly) painterly.setSize(clientWidth, clientHeight);
      else renderer.setSize(clientWidth, clientHeight);
      camera.aspect = clientWidth / clientHeight;
      camera.updateProjectionMatrix();
    });
    resizeObs.observe(hostEl);

    rebuildWorld();
    fitView(false);
    animationFrame = requestAnimationFrame(frame);
  });

  // Rebuild when the graph data or theme changes.
  createEffect(
    on(
      () => {
        const state = graphState();
        return [
          state?.nodes,
          state?.links,
          state?.adjacencyMap,
          state?.clusters,
          getEffectiveTheme(),
          getVoxelRenderSettings().maxAgents,
          getVoxelRenderSettings().agentSpeed,
          getVoxelRenderSettings().natureDensity,
        ] as const;
      },
      () => rebuildWorld(),
      { defer: true },
    ),
  );

  // Track the note that is open in the editor.
  createEffect(() => {
    engine?.setFocus(currentFilePath(), followMode());
    if (followMode() && currentFilePath()) locateCurrent();
  });

  onCleanup(() => {
    if (animationFrame !== undefined) cancelAnimationFrame(animationFrame);
    resizeObs?.disconnect();
    if (hostEl) {
      hostEl.removeEventListener("pointermove", handlePointerMove);
      hostEl.removeEventListener("pointerleave", handlePointerLeave);
      hostEl.removeEventListener("pointerdown", handlePointerDown);
      hostEl.removeEventListener("pointerup", handlePointerUp);
    }
    window.removeEventListener("keydown", handleKeyDown);
    controls?.dispose();
    if (engine) {
      scene?.remove(engine.group);
      engine.dispose();
      engine = undefined;
    }
    painterly?.dispose();
    releaseModelResources?.();
    releaseModelResources = undefined;
    renderer?.dispose();
    if (hostEl) {
      while (hostEl.firstChild) hostEl.removeChild(hostEl.firstChild);
    }
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
                <div class="mx-auto h-2.5 w-24 animate-pulse rounded-xs bg-element-selected" />
                <p class="text-sm text-text-secondary">{t("voxel_graph.status.indexing")}</p>
              </div>
            </Show>

            <Show when={!initError() && status() === "error"}>
              <p class="text-sm text-text-secondary">
                {store()?.state.error ?? t("voxel_graph.status.unknown_error")}
              </p>
            </Show>

            <Show when={!initError() && status() === "empty"}>
              <div class="space-y-2">
                <p class="text-sm text-text-secondary">{t("voxel_graph.status.empty")}</p>
                <p class="text-xs text-text-muted">{t("voxel_graph.status.empty_hint")}</p>
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
          class="absolute top-3 left-3 rounded-xs border border-border/70 bg-bg-elevated/85 px-3 py-2 font-mono text-[0.6875rem] text-text-muted tabular-nums shadow-soft-2 backdrop-blur-sm"
          classList={{ "top-2 left-2 px-2 py-1 text-[0.625rem]": isCompact() }}
        >
          {tf("voxel_graph.metric.visible", {
            nodes: visibleStats().nodes,
            links: visibleStats().links,
          })}
        </div>

        <div
          class="absolute right-3 bottom-3 flex items-center gap-0.5 rounded-xs border border-border/70 bg-bg-elevated/85 p-1 shadow-soft-2 backdrop-blur-sm"
          classList={{ "right-2! bottom-2! gap-0! p-0.5!": isCompact() }}
        >
          <CtrlBtn
            title={t("graph.ctrl.zoom_in")}
            onClick={() => zoomBy(0.8)}
            compact={isCompact()}
          >
            <ZoomInIcon />
          </CtrlBtn>
          <CtrlBtn
            title={t("graph.ctrl.zoom_out")}
            onClick={() => zoomBy(1.25)}
            compact={isCompact()}
          >
            <ZoomOutIcon />
          </CtrlBtn>
          <CtrlBtn title={t("graph.ctrl.fit_all")} onClick={() => fitView()} compact={isCompact()}>
            <FitViewIcon />
          </CtrlBtn>
          <CtrlBtn
            title={followMode() ? t("graph.ctrl.stop_following") : t("graph.ctrl.follow_current")}
            onClick={() => {
              const next = !followMode();
              setFollowMode(next);
              if (next) locateCurrent();
            }}
            active={followMode()}
            compact={isCompact()}
          >
            <LocateIcon />
          </CtrlBtn>
          <CtrlBtn title={t("graph.ctrl.reset_view")} onClick={resetView} compact={isCompact()}>
            <ResetViewIcon />
          </CtrlBtn>
          <div class="mx-1 h-4 w-px bg-border" />
          <span
            class="min-w-11 px-1 text-center font-mono text-[0.6875rem] text-text-muted tabular-nums"
            classList={{ "min-w-8 text-[0.625rem]": isCompact() }}
          >
            {Math.round(zoomLevel() * 100)}%
          </span>
        </div>
      </Show>

      <Show when={hoveredNode()}>
        {(node) => (
          <div class="pointer-events-none absolute bottom-14 left-3 max-w-72 rounded-xs border border-border/70 bg-bg-elevated/90 px-3 py-2 shadow-popover backdrop-blur-sm">
            <p class="truncate text-[0.8125rem] font-medium text-text-primary">
              {shortLabel(node().name)}
            </p>
            <div class="mt-1 flex flex-wrap items-center gap-2 text-[0.6875rem] text-text-muted">
              <span class="truncate">{node().folder || "Root"}</span>
              <span class="rounded-xs bg-bg-secondary px-1.5 py-0.5 text-[0.625rem]">
                {t(JOB_LABEL_KEYS[classForNode(node())])}
              </span>
              <span>
                {hoveredConnections() === 1
                  ? tf("graph.tooltip.connection_one", { count: hoveredConnections() })
                  : tf("graph.tooltip.connection_other", { count: hoveredConnections() })}
              </span>
              <Show when={node().isOrphan}>
                <span class="rounded-xs bg-bg-secondary px-1.5 py-0.5 text-[0.625rem] text-text-muted">
                  {t("graph.badge.unlinked")}
                </span>
              </Show>
            </div>
          </div>
        )}
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
