import { CurvedSurface } from "./curved_surface";
// ── Agent World Engine ──
//
// Assembles the harbor world (sky, terrain, nature, buildings, paths,
// agents) into a single Group, drives the per-frame simulation, and resolves
// picking and highlight state. The hosting canvas owns the renderer and
// camera; the engine owns everything inside the world.

import { Group, Vector3, type Raycaster } from "three";
import SpriteText from "three-spritetext";

import type { GraphLink, GraphNode } from "~/plugins/builtin/graph_view/graph_types";

import {
  BLOCK,
  computeIslands,
  computePlots,
  islandLabelText,
  shortLabel,
  islandSurfaceY,
  worldRadius as computeWorldRadius,
  type IslandSpec,
} from "../voxel_layout";
import {
  agentSpeedMultiplier,
  natureDensityMultiplier,
  VOXEL_RENDER_SETTINGS_DEFAULTS,
  type VoxelRenderSettings,
} from "../voxel_render_options";
import {
  createAgents,
  type AgentsHandle,
  type AgentWorldSnapshot,
  type ResidentStatus,
} from "./agents";
import { createBuildings, type BuildingsHandle } from "./buildings";
import {
  createInteractionIndicators,
  type InteractionIndicatorAnchor,
  type InteractionIndicatorEntry,
  type InteractionIndicatorKind,
} from "./indicators";
import { createNature, type NatureHandle } from "./nature";
import { clusterAccent, paletteForMood, type WorldMood, type WorldPalette } from "./palette";
import { createPaths, type PathsHandle, type TrailPair } from "./paths";
import { createSky, type SkyHandle } from "./sky";
import { createTerrain, type TerrainHandle } from "./terrain";

export interface AgentWorldOptions {
  nodes: readonly GraphNode[];
  links: readonly GraphLink[];
  adjacencyMap: Record<string, string[]>;
  clusters: readonly string[];
  mood: WorldMood;
  compact: boolean;
  labelFontFamily?: string;
  renderSettings?: VoxelRenderSettings;
  /** Agent state from a previous engine, so rebuilds don't reset positions. */
  restoreAgents?: AgentWorldSnapshot;
}

export interface AgentWorldEngine {
  group: Group;
  palette: WorldPalette;
  worldRadius: number;
  surface: CurvedSurface;
  islands: readonly IslandSpec[];
  update(nowSeconds: number, deltaSeconds: number): void;
  setPaused(paused: boolean): void;
  setHovered(filePath: string | null): void;
  setSelected(filePath: string | null): void;
  /** The note open in the editor — gets a banner marker and glowing trails. */
  setFocus(filePath: string | null, preferAgent?: boolean): void;
  pick(raycaster: Raycaster): GraphNode | null;
  pickedSource(): "agent" | "building" | null;
  /** Camera anchor for locate/follow: the agent if roaming, else the house. */
  anchorFor(filePath: string): Vector3 | null;
  residentLabelFor(filePath: string): string | null;
  residentStatusFor(filePath: string): ResidentStatus | null;
  greet(filePath: string, viewerPosition?: Vector3): void;
  dispatch(filePath: string): boolean;
  cancelDelivery(filePath: string): void;
  /** Captures agent state to hand to the next engine instance. */
  agentSnapshot(): AgentWorldSnapshot;
  dispose(): void;
}

function buildIslandLabels(
  islands: readonly IslandSpec[],
  palette: WorldPalette,
  compact: boolean,
  roofHeights: ReadonlyMap<number, number>,
  surface: CurvedSurface,
  fontFamily?: string,
): Group {
  const group = new Group();
  for (const island of islands) {
    const label = new SpriteText(islandLabelText(island.name));
    label.textHeight = compact ? 4 : 4.5;
    if (fontFamily) label.fontFace = fontFamily;
    label.color =
      palette.mood === "night"
        ? clusterAccent(island.clusterIndex, palette.mood)
        : palette.labelText;
    label.backgroundColor =
      palette.mood === "night" ? palette.labelBg : clusterAccent(island.clusterIndex, palette.mood);
    label.padding = [1.5, 2.5];
    label.borderRadius = 2;
    label.material.depthWrite = false;
    const at = surface.project(
      new Vector3(
        island.center.x,
        islandSurfaceY(island) + (roofHeights.get(island.clusterIndex) ?? 30) + 8,
        island.center.z - 12,
      ),
    );
    label.position.set(at.x, at.y, at.z);
    group.add(label);
  }
  return group;
}

function disposeLabels(group: Group): void {
  for (const child of group.children) {
    const sprite = child as SpriteText;
    sprite.material.map?.dispose();
    sprite.material.dispose();
  }
  group.clear();
}

export function createAgentWorld(options: AgentWorldOptions): AgentWorldEngine {
  const palette = paletteForMood(options.mood);
  const renderSettings = options.renderSettings ?? VOXEL_RENDER_SETTINGS_DEFAULTS;
  const group = new Group();

  // ── Layout ──
  const islands = computeIslands(options.nodes, options.clusters);
  const plots = computePlots(options.nodes, islands);
  const radius = computeWorldRadius(islands);
  const surface = new CurvedSurface(radius);

  // ── World pieces ──
  const sky: SkyHandle = createSky(palette, radius);
  const terrain: TerrainHandle = createTerrain(islands, palette, radius, surface);
  const buildings: BuildingsHandle = createBuildings(plots, palette, surface);
  const nature: NatureHandle = createNature(islands, plots, palette, {
    densityMultiplier: natureDensityMultiplier(renderSettings.natureDensity),
    surface,
  });
  const paths: PathsHandle = createPaths({
    surface,
    islands,
    plots,
    links: options.links,
    roofPosition: (filePath) => buildings.roofPosition(filePath),
    doorPosition: (filePath) => buildings.doorPosition(filePath),
    palette,
  });
  const agents: AgentsHandle = createAgents({
    surface,
    plots,
    adjacencyMap: options.adjacencyMap,
    bridges: paths.bridges,
    routeBetween: (from, to) => paths.routeBetween(from, to),
    doorPosition: (filePath) => buildings.doorPosition(filePath),
    palette,
    workSites: nature.workSites,
    maxAgents: renderSettings.maxAgents === "all" ? plots.size : renderSettings.maxAgents,
    speedMultiplier: agentSpeedMultiplier(renderSettings.agentSpeed),
    restore: options.restoreAgents,
  });
  const roofHeights = new Map<number, number>();
  for (const plot of plots.values()) {
    const height = buildings.roofPosition(plot.node.filePath)?.y ?? 30;
    roofHeights.set(
      plot.island.clusterIndex,
      Math.max(roofHeights.get(plot.island.clusterIndex) ?? 0, height),
    );
  }
  const labels = buildIslandLabels(
    islands,
    palette,
    options.compact,
    roofHeights,
    surface,
    options.labelFontFamily,
  );
  const noteLabel = new SpriteText("");
  noteLabel.textHeight = 4;
  if (options.labelFontFamily) noteLabel.fontFace = options.labelFontFamily;
  noteLabel.color = "#fffaf0";
  noteLabel.backgroundColor = palette.mood === "night" ? "#3b3430" : "#b86d57";
  noteLabel.padding = [1.2, 2];
  noteLabel.borderRadius = 1.3;
  noteLabel.material.depthWrite = false;
  noteLabel.visible = false;
  labels.add(noteLabel);
  let labeledPath: string | null = null;

  group.add(sky.group, terrain.group, buildings.group, nature.group, paths.group, agents.group);
  group.add(labels);

  let focusPath: string | null = null;
  const indicators = createInteractionIndicators(palette, surface);
  group.add(indicators.mesh);

  function updateFocusTrails(): void {
    const routePath = selectedPath ?? hoveredPath ?? focusPath;
    if (!routePath) {
      paths.setFocusTrails([]);
      return;
    }
    const fromDoor = buildings.roofPosition(routePath);
    if (!fromDoor) {
      paths.setFocusTrails([]);
      return;
    }
    const pairs: TrailPair[] = [];
    for (const neighbour of options.adjacencyMap[routePath] ?? []) {
      const toDoor = buildings.roofPosition(neighbour);
      if (toDoor) pairs.push({ from: fromDoor, to: toDoor });
    }
    paths.setFocusTrails(pairs);
  }

  // ── Highlight state (priority: selected > hovered > focus indicator) ──
  type IndicatorSource = "agent" | "building";

  let hoveredPath: string | null = null;
  let selectedPath: string | null = null;
  let focusSource: IndicatorSource | null = null;
  let hoveredSource: IndicatorSource | null = null;
  let selectedSource: IndicatorSource | null = null;
  let lastPicked: { filePath: string; source: IndicatorSource } | null = null;
  let indicatorNowSeconds = 0;

  const KIND_PRIORITY: Record<InteractionIndicatorKind, number> = {
    focus: 0,
    hover: 1,
    selected: 2,
  };

  function consumePickedSource(filePath: string | null): IndicatorSource | null {
    if (!filePath || lastPicked?.filePath !== filePath) return null;
    return lastPicked.source;
  }

  function indicatorAnchorFor(
    filePath: string,
    preferredSource: IndicatorSource | null,
  ): InteractionIndicatorAnchor | null {
    if (preferredSource === "agent") {
      return agents.indicatorAnchor(filePath) ?? buildings.indicatorAnchor(filePath);
    }
    if (preferredSource === "building") {
      return buildings.indicatorAnchor(filePath) ?? agents.indicatorAnchor(filePath);
    }
    return buildings.indicatorAnchor(filePath) ?? agents.indicatorAnchor(filePath);
  }

  function applyIndicators(): void {
    const path = selectedPath ?? hoveredPath ?? focusPath;
    if (path !== labeledPath) {
      labeledPath = path;
      const plot = path ? plots.get(path) : null;
      const roof = path ? buildings.roofPosition(path) : null;
      noteLabel.visible = !!plot && !!roof;
      if (plot && roof) {
        noteLabel.text = shortLabel(plot.node.name);
        const at = surface.project(roof.clone().add(new Vector3(0, 7, 0)));
        noteLabel.position.set(at.x, at.y, at.z);
      }
    }
    const byPath = new Map<
      string,
      { kind: InteractionIndicatorKind; source: IndicatorSource | null }
    >();
    if (focusPath) byPath.set(focusPath, { kind: "focus", source: focusSource });
    if (hoveredPath) byPath.set(hoveredPath, { kind: "hover", source: hoveredSource });
    if (selectedPath) byPath.set(selectedPath, { kind: "selected", source: selectedSource });

    const groundEntries: InteractionIndicatorEntry[] = [];
    for (const [filePath, state] of byPath) {
      if (state.source === "agent") {
        const characterAnchor = agents.indicatorAnchor(filePath);
        if (characterAnchor) {
          groundEntries.push({ kind: state.kind, anchor: characterAnchor, tone: "character" });
          continue;
        }
      }
      const anchor = indicatorAnchorFor(filePath, state.source);
      if (anchor) groundEntries.push({ kind: state.kind, anchor });
    }

    groundEntries.sort((left, right) => KIND_PRIORITY[left.kind] - KIND_PRIORITY[right.kind]);
    indicators.write(groundEntries, indicatorNowSeconds);
  }

  // ── Frame loop ──
  let paused = false;

  function update(nowSeconds: number, deltaSeconds: number): void {
    indicatorNowSeconds = nowSeconds;
    terrain.update(nowSeconds);
    buildings.update(nowSeconds);
    if (paused) {
      applyIndicators();
      return;
    }
    sky.update(nowSeconds);
    nature.update(nowSeconds);
    paths.update(nowSeconds);
    agents.update(nowSeconds, Math.min(deltaSeconds, 0.12));
    applyIndicators();
  }

  // ── Picking ──
  function pick(raycaster: Raycaster): GraphNode | null {
    const hits = raycaster.intersectObjects([agents.pickMesh, buildings.pickMesh], false);
    for (const hit of hits) {
      if (hit.instanceId === undefined) continue;
      const source: IndicatorSource = hit.object === agents.pickMesh ? "agent" : "building";
      const handle = source === "agent" ? agents : buildings;
      const node = handle.nodeForInstance(hit.instanceId);
      if (node) {
        lastPicked = { filePath: node.filePath, source };
        return node;
      }
    }
    lastPicked = null;
    return null;
  }

  return {
    group,
    palette,
    worldRadius: radius,
    surface,
    islands,
    update,
    setPaused: (value) => {
      paused = value;
    },
    setHovered: (filePath) => {
      const source = consumePickedSource(filePath);
      if (hoveredPath === filePath && hoveredSource === source) return;
      hoveredPath = filePath;
      hoveredSource = source;
      updateFocusTrails();
      applyIndicators();
    },
    setSelected: (filePath) => {
      const source = consumePickedSource(filePath);
      if (selectedPath === filePath && selectedSource === source) return;
      selectedPath = filePath;
      selectedSource = source;
      updateFocusTrails();
      applyIndicators();
    },
    setFocus: (filePath, preferAgent = false) => {
      const source: IndicatorSource | null = filePath && preferAgent ? "agent" : null;
      if (focusPath === filePath && focusSource === source) return;
      focusPath = filePath;
      focusSource = source;
      updateFocusTrails();
      applyIndicators();
    },
    pick,
    pickedSource: () => lastPicked?.source ?? null,
    residentStatusFor: (filePath) => agents.statusFor(filePath),
    greet: (filePath, viewerPosition) => agents.greet(filePath, viewerPosition),
    dispatch: (filePath) => agents.dispatch(filePath),
    cancelDelivery: (filePath) => agents.cancelDelivery(filePath),
    residentLabelFor: (filePath) => agents.residentLabelFor(filePath),
    anchorFor: (filePath) => {
      const agentAt = agents.agentPosition(filePath);
      if (agentAt) return surface.project(agentAt.add(new Vector3(0, BLOCK, 0)));
      const roof = buildings.roofPosition(filePath);
      return roof ? surface.project(roof) : null;
    },
    agentSnapshot: () => agents.snapshot(),
    dispose: () => {
      sky.dispose();
      terrain.dispose();
      buildings.dispose();
      nature.dispose();
      paths.dispose();
      agents.dispose();
      indicators.dispose();
      disposeLabels(labels);
    },
  };
}
