// ── Agent World Engine ──
//
// Assembles the whole medieval world (sky, terrain, nature, buildings, paths,
// agents) into a single Group, drives the per-frame simulation, and resolves
// picking and highlight state. The hosting canvas owns the renderer and
// camera; the engine owns everything inside the world.

import { Group, Vector3, type MeshBasicMaterial, type Raycaster } from "three";
import SpriteText from "three-spritetext";

import type { GraphLink, GraphNode } from "~/plugins/builtin/graph_view/graph_types";

import {
  BLOCK,
  computeIslands,
  computePlots,
  islandLabelText,
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
import { createAgents, type AgentsHandle, type AgentWorldSnapshot } from "./agents";
import { glowBatch, type VoxelBatch } from "./batch";
import { createBuildings, type BuildingsHandle } from "./buildings";
import {
  createInteractionIndicators,
  type InteractionIndicatorAnchor,
  type InteractionIndicatorEntry,
  type InteractionIndicatorKind,
} from "./indicators";
import { createNature, type NatureHandle } from "./nature";
import { paletteForMood, type WorldMood, type WorldPalette } from "./palette";
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
  renderSettings?: VoxelRenderSettings;
  /** Agent state from a previous engine, so rebuilds don't reset positions. */
  restoreAgents?: AgentWorldSnapshot;
}

export interface AgentWorldEngine {
  group: Group;
  palette: WorldPalette;
  worldRadius: number;
  islands: readonly IslandSpec[];
  update(nowSeconds: number, deltaSeconds: number): void;
  setPaused(paused: boolean): void;
  setHovered(filePath: string | null): void;
  setSelected(filePath: string | null): void;
  /** The note open in the editor — gets a banner marker and glowing trails. */
  setFocus(filePath: string | null, preferAgent?: boolean): void;
  pick(raycaster: Raycaster): GraphNode | null;
  /** Camera anchor for locate/follow: the agent if roaming, else the house. */
  anchorFor(filePath: string): Vector3 | null;
  /** Captures agent state to hand to the next engine instance. */
  agentSnapshot(): AgentWorldSnapshot;
  dispose(): void;
}

function buildIslandLabels(
  islands: readonly IslandSpec[],
  palette: WorldPalette,
  compact: boolean,
): Group {
  const group = new Group();
  for (const island of islands) {
    const label = new SpriteText(islandLabelText(island.name));
    label.textHeight = compact ? 5 : 6.5;
    label.color = palette.labelText;
    label.backgroundColor = palette.labelBg;
    label.padding = 2;
    label.borderRadius = 2;
    label.material.depthWrite = false;
    label.position.set(island.center.x, islandSurfaceY(island) + 24, island.center.z);
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

  // ── World pieces ──
  const sky: SkyHandle = createSky(palette, radius);
  const terrain: TerrainHandle = createTerrain(islands, palette, radius);
  const buildings: BuildingsHandle = createBuildings(plots, palette);
  const nature: NatureHandle = createNature(islands, plots, palette, {
    densityMultiplier: natureDensityMultiplier(renderSettings.natureDensity),
  });
  const paths: PathsHandle = createPaths({
    islands,
    plots,
    links: options.links,
    doorPosition: (filePath) => buildings.doorPosition(filePath),
    palette,
  });
  const agents: AgentsHandle = createAgents({
    plots,
    adjacencyMap: options.adjacencyMap,
    bridges: paths.bridges,
    doorPosition: (filePath) => buildings.doorPosition(filePath),
    palette,
    workSites: nature.workSites,
    maxAgents: renderSettings.maxAgents === "all" ? plots.size : renderSettings.maxAgents,
    speedMultiplier: agentSpeedMultiplier(renderSettings.agentSpeed),
    restore: options.restoreAgents,
  });
  const labels = buildIslandLabels(islands, palette, options.compact);

  group.add(sky.group, terrain.group, buildings.group, nature.group, paths.group, agents.group);
  group.add(labels);

  // ── Focus marker: a quest banner by the door plus four flat corner
  // brackets framing the plot, like an RPG target reticle. Everything is
  // planted on the ground; the only animation is a soft glow.
  const MARKER_INSTANCES = 3 + 8;
  const marker: VoxelBatch = glowBatch(MARKER_INSTANCES, true, 0.85);
  marker.reserve(MARKER_INSTANCES);
  marker.commit();
  group.add(marker.mesh);
  const markerMaterial = marker.mesh.material as MeshBasicMaterial;
  let focusPath: string | null = null;

  const indicators = createInteractionIndicators(palette);
  group.add(indicators.mesh);

  function clearFocusMarker(): void {
    for (let index = 0; index < MARKER_INSTANCES; index++) marker.hide(index);
    marker.commit();
  }

  function writeFocusMarker(): void {
    if (!focusPath) {
      clearFocusMarker();
      return;
    }
    const plot = plots.get(focusPath);
    const door = buildings.doorPosition(focusPath);
    if (!plot || !door) {
      clearFocusMarker();
      return;
    }

    // Banner pole beside the door (offset along the house's local X axis).
    const cos = Math.cos(plot.rotationY);
    const sin = Math.sin(plot.rotationY);
    const poleX = door.x + 3.2 * cos;
    const poleZ = door.z - 3.2 * sin;
    marker.set(0, {
      x: poleX,
      y: plot.position.y + 6,
      z: poleZ,
      sx: 0.5,
      sy: 12,
      sz: 0.5,
      color: palette.focusFlag,
    });
    marker.set(1, {
      x: poleX + 1.6 * cos,
      y: plot.position.y + 10.2,
      z: poleZ - 1.6 * sin,
      sx: 2.6,
      sy: 2.8,
      sz: 0.35,
      rotY: plot.rotationY,
      color: palette.beacon,
    });
    marker.set(2, {
      x: poleX,
      y: plot.position.y + 12.3,
      z: poleZ,
      sx: 1,
      sy: 0.6,
      sz: 1,
      color: palette.focusFlag,
    });

    // Corner brackets: an L of two flat arms at each corner of the plot.
    const half = 9.4;
    const armLength = 4.4;
    const armWidth = 1;
    const bracketY = plot.position.y + 0.36;
    let bracketSlot = 3;
    for (const cornerX of [-1, 1]) {
      for (const cornerZ of [-1, 1]) {
        // Arm running along X.
        marker.set(bracketSlot, {
          x: plot.position.x + cornerX * (half - armLength / 2),
          y: bracketY,
          z: plot.position.z + cornerZ * half,
          sx: armLength,
          sy: 0.45,
          sz: armWidth,
          color: palette.beacon,
        });
        // Arm running along Z.
        marker.set(bracketSlot + 1, {
          x: plot.position.x + cornerX * half,
          y: bracketY,
          z: plot.position.z + cornerZ * (half - armLength / 2),
          sx: armWidth,
          sy: 0.45,
          sz: armLength,
          color: palette.beacon,
        });
        bracketSlot += 2;
      }
    }
    marker.commit();
  }

  function updateFocusTrails(): void {
    if (!focusPath) {
      paths.setFocusTrails([]);
      return;
    }
    const fromDoor = buildings.doorPosition(focusPath);
    if (!fromDoor) {
      paths.setFocusTrails([]);
      return;
    }
    const pairs: TrailPair[] = [];
    for (const neighbour of options.adjacencyMap[focusPath] ?? []) {
      const toDoor = buildings.doorPosition(neighbour);
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
    if (focusPath) {
      markerMaterial.opacity = 0.72 + Math.sin(nowSeconds * 2.2) * 0.16;
    }
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
      applyIndicators();
    },
    setSelected: (filePath) => {
      const source = consumePickedSource(filePath);
      if (selectedPath === filePath && selectedSource === source) return;
      selectedPath = filePath;
      selectedSource = source;
      applyIndicators();
    },
    setFocus: (filePath, preferAgent = false) => {
      const source: IndicatorSource | null = filePath && preferAgent ? "agent" : null;
      if (focusPath === filePath && focusSource === source) return;
      focusPath = filePath;
      focusSource = source;
      writeFocusMarker();
      updateFocusTrails();
      applyIndicators();
    },
    pick,
    anchorFor: (filePath) => {
      const agentAt = agents.agentPosition(filePath);
      if (agentAt) return agentAt.add(new Vector3(0, BLOCK, 0));
      return buildings.roofPosition(filePath);
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
      marker.dispose();
      disposeLabels(labels);
    },
  };
}
