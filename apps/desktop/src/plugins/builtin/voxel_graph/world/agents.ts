// ── Agent World Agents ──
//
// One voxel adventurer per note, in classic medieval-RPG classes decided by
// the note's stats: well-linked hubs patrol as knights and nobles, long
// documents study as wizards, mid-linked notes scout as rangers, and the rest
// live as villagers and peasants. Agents wander their island, gather at the
// plaza, and cross bridges to visit notes they link to. Separation steering
// keeps characters from ever standing inside each other.

import { Group, Vector3, type InstancedMesh } from "three";

import type { GraphNode } from "~/plugins/builtin/graph_view/graph_types";

import { BLOCK, PLAZA_RADIUS, stableNoise, type IslandSpec, type PlotSpec } from "../voxel_layout";
import { glowBatch, solidBatch, type VoxelBatch } from "./batch";
import type { WorkSite, WorkSites } from "./nature";
import { clusterAccent, type WorldPalette } from "./palette";
import { bridgeKey, type BridgeInfo } from "./paths";

export interface AgentsHandle {
  group: Group;
  pickMesh: InstancedMesh;
  nodeForInstance(instanceId: number): GraphNode | null;
  agentPosition(filePath: string): Vector3 | null;
  setTint(filePath: string, tint: string | null): void;
  update(nowSeconds: number, deltaSeconds: number): void;
  /** Captures every agent's live state so a rebuild can resume seamlessly. */
  snapshot(): AgentWorldSnapshot;
  dispose(): void;
}

/** A visible job an agent performs at a work site. */
export type WorkKind = "farm" | "sell" | "chop" | "study" | "drill" | "inspect";

interface PendingWork {
  kind: WorkKind;
  faceHeading: number;
}

/** Live state of one agent, survives world rebuilds (e.g. theme switches). */
export interface AgentSnapshot {
  position: Vector3;
  heading: number;
  targetHeading: number;
  state: "idle" | "walk" | "pause" | "work";
  waypoints: Vector3[];
  waypointIndex: number;
  restTimer: number;
  walkPhase: number;
  awayFromHome: boolean;
  workKind: WorkKind | null;
  workTimer: number;
  pendingWork: PendingWork | null;
}

export type AgentWorldSnapshot = ReadonlyMap<string, AgentSnapshot>;

const PARTS_PER_AGENT = 20;
const WALK_SPEED = 8.5;
const TURN_SPEED = 7;
/** Personal space between two characters, scaled by their sizes. */
const SEPARATION_BASE = 4.2;
/** Keep-out radius around every house plot center. */
const HOUSE_RADIUS = 6.6;
/** Walking with almost no progress for this long skips the blocked waypoint. */
const STUCK_LIMIT_SECONDS = 1.6;
/** How long a chance greeting lasts, and the cooldown before the next one. */
const GREET_SECONDS_MIN = 1.4;
const GREET_SECONDS_VAR = 1.2;
const GREET_COOLDOWN_MIN = 14;
const GREET_COOLDOWN_VAR = 22;

const SKIN_TONES = ["#e8b88a", "#d9a06a", "#c08552", "#9c6a42", "#7a5234"];
const HAIR_TONES = ["#3a2a1c", "#6b4226", "#9c6a3a", "#c8923e", "#50463c", "#8c3a2c"];
const TUNIC_TONES = ["#c84f3f", "#3f7fc8", "#3f9a64", "#d8a03a", "#8a5fc8", "#3aa8a0", "#c85f9a"];
const PANTS_TONES = ["#37506e", "#4a3c30", "#54616b", "#3c5a46", "#6e4a38"];
const ROBE_TONES = ["#3a4a8c", "#5a3a7a", "#6e3050", "#2e5a64", "#503a6e"];
const LEATHER_TONES = ["#7a5a38", "#6a4c30", "#5c503a"];

const STEEL = "#b6bec8";
const STEEL_DARK = "#6e7888";
const BLADE = "#dde2e8";
const GOLD = "#e0b23c";
const STRAW = "#d8b86a";
const WOOD = "#7a5230";
const BOOT = "#46362a";
const ROPE = "#c8a35a";

export type AgentClass = "knight" | "wizard" | "ranger" | "noble" | "peasant" | "villager";

interface AgentLook {
  agentClass: AgentClass;
  skin: string;
  hair: string;
  tunic: string;
  pants: string;
  accent: string;
  robe: string;
  leather: string;
  scale: number;
  /** Cosmetic extras rolled per agent for variety. */
  beard: string | null;
  longHair: boolean;
  pouch: boolean;
  backpack: boolean;
  emblem: boolean;
}

type AgentState = "idle" | "walk" | "pause" | "work";

interface AgentRuntime {
  node: GraphNode;
  plot: PlotSpec;
  look: AgentLook;
  firstInstance: number;
  home: Vector3;
  position: Vector3;
  heading: number;
  targetHeading: number;
  state: AgentState;
  waypoints: Vector3[];
  waypointIndex: number;
  /** Seconds until the next decision while idle/paused. */
  restTimer: number;
  walkPhase: number;
  bobSeed: number;
  /** Set while away from home so the agent walks back afterwards. */
  awayFromHome: boolean;
  /** Seconds of walking without progress (blocked by a house or a crowd). */
  stuckTime: number;
  lastX: number;
  lastZ: number;
  /** Remaining seconds of a greeting exchange; 0 when not greeting. */
  greetTimer: number;
  greetCooldownUntil: number;
  /** Current job while state === "work". */
  workKind: WorkKind | null;
  workTimer: number;
  /** Job to start once the current walk reaches its destination. */
  pendingWork: PendingWork | null;
  /** Personal walking pace — everyone moves a little differently. */
  speed: number;
}

interface AgentsOptions {
  plots: ReadonlyMap<string, PlotSpec>;
  adjacencyMap: Record<string, string[]>;
  bridges: ReadonlyMap<string, BridgeInfo>;
  doorPosition(filePath: string): Vector3 | null;
  palette: WorldPalette;
  /** Village work sites (fields, stalls, wells, trees) agents can use. */
  workSites?: WorkSites;
  /** Restores agent positions/journeys from a previous world instance. */
  restore?: AgentWorldSnapshot;
}

// ── Class & look ──────────────────────────────────────────────

export function classForNode(node: GraphNode): AgentClass {
  const length = node.documentLength ?? 0;
  if (node.linkCount >= 10) return "noble";
  if (node.linkCount >= 7) return "knight";
  if (length >= 5_000) return "wizard";
  if (node.linkCount >= 4) return "ranger";
  if (node.isOrphan) return "peasant";
  const roll = stableNoise(`${node.id}:class`);
  if (roll < 0.55) return "villager";
  if (roll < 0.8) return "peasant";
  return "ranger";
}

const BEARD_TONES = ["#3a2a1c", "#6b4226", "#50463c", "#8c8478", "#b8b2a8"];
const WIZARD_BEARD_TONES = ["#d8d4cc", "#b8b2a8", "#8c8478"];

function lookForNode(node: GraphNode, island: IslandSpec, palette: WorldPalette): AgentLook {
  const pick = (tones: readonly string[], salt: string) =>
    tones[Math.floor(stableNoise(`${node.id}:${salt}`) * tones.length)];
  const roll = (salt: string) => stableNoise(`${node.id}:${salt}`);
  const accent = clusterAccent(island.clusterIndex, palette.mood);
  const agentClass = classForNode(node);

  // Cosmetic extras: wizards are almost always bearded sages, workers carry
  // gear, livery wearers get a chest emblem.
  const beardChance = agentClass === "wizard" ? 0.85 : 0.28;
  const wearsLivery = roll("livery") < 0.34;
  return {
    agentClass,
    skin: pick(SKIN_TONES, "skin"),
    hair: pick(HAIR_TONES, "hair"),
    tunic: wearsLivery ? accent : pick(TUNIC_TONES, "tunic"),
    pants: pick(PANTS_TONES, "pants"),
    accent,
    robe: pick(ROBE_TONES, "robe"),
    leather: pick(LEATHER_TONES, "leather"),
    scale: 0.92 + Math.min(8, node.linkCount) * 0.035,
    beard:
      roll("beard") < beardChance
        ? pick(agentClass === "wizard" ? WIZARD_BEARD_TONES : BEARD_TONES, "beardcol")
        : null,
    longHair: roll("longhair") < 0.32,
    pouch: roll("pouch") < 0.45 && agentClass !== "knight" && agentClass !== "wizard",
    backpack: roll("backpack") < 0.35 && (agentClass === "villager" || agentClass === "peasant"),
    emblem: wearsLivery && agentClass !== "knight" && agentClass !== "wizard",
  };
}

// ── Movement helpers ──────────────────────────────────────────

function shortestAngle(from: number, to: number): number {
  let delta = (to - from) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
}

function routeAlong(agent: AgentRuntime, points: Vector3[]): void {
  agent.waypoints = points;
  agent.waypointIndex = 0;
  agent.state = "walk";
}

function siteOnIsland(sites: readonly WorkSite[], clusterIndex: number): WorkSite | null {
  const local = sites.filter((site) => site.clusterIndex === clusterIndex);
  if (local.length === 0) return null;
  return local[Math.floor(Math.random() * local.length)];
}

/** At the end of a walk: clock in at the work site, or just take a break. */
function startPendingWorkOrPause(agent: AgentRuntime): void {
  if (agent.pendingWork) {
    agent.state = "work";
    agent.workKind = agent.pendingWork.kind;
    agent.workTimer = 6 + Math.random() * 8;
    agent.targetHeading = agent.pendingWork.faceHeading;
    agent.pendingWork = null;
    return;
  }
  agent.state = "pause";
  agent.restTimer = 1.5 + Math.random() * 4.5;
  agent.targetHeading = agent.heading + (Math.random() - 0.5) * 1.2;
}

function plazaPoint(island: IslandSpec): Vector3 {
  const angle = Math.random() * Math.PI * 2;
  const radius = Math.random() * PLAZA_RADIUS * 0.7 * BLOCK;
  return new Vector3(
    island.center.x + Math.cos(angle) * radius,
    island.elevation * BLOCK,
    island.center.z + Math.sin(angle) * radius,
  );
}

export function createAgents(options: AgentsOptions): AgentsHandle {
  const { plots, adjacencyMap, bridges, palette } = options;
  const group = new Group();

  const batch: VoxelBatch = solidBatch(Math.max(1, plots.size * PARTS_PER_AGENT), true);
  group.add(batch.mesh);

  // Soft blob shadow under every character — grounds them on the terrain.
  const shadows: VoxelBatch = glowBatch(Math.max(1, plots.size), true, 0.2);
  shadows.reserve(Math.max(1, plots.size));
  group.add(shadows.mesh);

  const agents: AgentRuntime[] = [];
  const byFilePath = new Map<string, AgentRuntime>();

  // House plot centers per island, so wander targets stay out of buildings.
  const plotsByIsland = new Map<number, Vector3[]>();
  for (const plot of plots.values()) {
    const list = plotsByIsland.get(plot.island.clusterIndex) ?? [];
    list.push(plot.position);
    plotsByIsland.set(plot.island.clusterIndex, list);
  }

  // Static spatial hash of house obstacles, queried every frame to keep
  // characters from clipping through (or standing inside) buildings.
  const OBSTACLE_CELL = HOUSE_RADIUS * 2.2;
  const obstacleGrid = new Map<string, Vector3[]>();
  for (const plot of plots.values()) {
    const key = `${Math.floor(plot.position.x / OBSTACLE_CELL)}:${Math.floor(plot.position.z / OBSTACLE_CELL)}`;
    const bucket = obstacleGrid.get(key);
    if (bucket) bucket.push(plot.position);
    else obstacleGrid.set(key, [plot.position]);
  }

  function nearbyHouses(x: number, z: number): Vector3[] {
    const cellX = Math.floor(x / OBSTACLE_CELL);
    const cellZ = Math.floor(z / OBSTACLE_CELL);
    const found: Vector3[] = [];
    for (let nx = cellX - 1; nx <= cellX + 1; nx++) {
      for (let nz = cellZ - 1; nz <= cellZ + 1; nz++) {
        const bucket = obstacleGrid.get(`${nx}:${nz}`);
        if (bucket) found.push(...bucket);
      }
    }
    return found;
  }

  /** Moves a point radially out of any house circle it landed in. */
  function pushOutOfHouses(point: Vector3, clearance = HOUSE_RADIUS + 0.8): Vector3 {
    for (const house of nearbyHouses(point.x, point.z)) {
      const dx = point.x - house.x;
      const dz = point.z - house.z;
      const dist = Math.hypot(dx, dz);
      if (dist >= clearance) continue;
      if (dist < 0.001) {
        point.x = house.x + clearance;
        continue;
      }
      point.x = house.x + (dx / dist) * clearance;
      point.z = house.z + (dz / dist) * clearance;
    }
    return point;
  }

  function wanderPoint(island: IslandSpec): Vector3 {
    const min = (PLAZA_RADIUS + 1) * BLOCK;
    const max = (island.radiusBlocks - 3) * BLOCK;
    const houses = plotsByIsland.get(island.clusterIndex) ?? [];
    let fallback: Vector3 | null = null;
    for (let attempt = 0; attempt < 6; attempt++) {
      const angle = Math.random() * Math.PI * 2;
      const radius = max > min ? min + Math.random() * (max - min) : min;
      const candidate = new Vector3(
        island.center.x + Math.cos(angle) * radius,
        island.elevation * BLOCK,
        island.center.z + Math.sin(angle) * radius,
      );
      const insideHouse = houses.some(
        (house) => Math.hypot(house.x - candidate.x, house.z - candidate.z) < 8,
      );
      if (!insideHouse) return candidate;
      fallback = candidate;
    }
    return fallback ?? plazaPoint(island);
  }

  for (const plot of plots.values()) {
    const firstInstance = batch.reserve(PARTS_PER_AGENT);
    if (firstInstance < 0) break;
    const door = options.doorPosition(plot.node.filePath);
    const home = door ?? plot.position.clone();
    // Stand a little beside the walkway, facing the plaza like the house does.
    home.x += (stableNoise(`${plot.node.id}:hx`) - 0.5) * BLOCK * 1.6;
    home.z += (stableNoise(`${plot.node.id}:hz`) - 0.5) * BLOCK * 1.6;
    home.y = plot.position.y;
    pushOutOfHouses(home);

    const agent: AgentRuntime = {
      node: plot.node,
      plot,
      look: lookForNode(plot.node, plot.island, palette),
      firstInstance,
      home: home.clone(),
      position: home.clone(),
      heading: plot.rotationY + Math.PI,
      targetHeading: plot.rotationY + Math.PI,
      state: "idle",
      waypoints: [],
      waypointIndex: 0,
      restTimer: 1 + stableNoise(`${plot.node.id}:rest`) * 6,
      walkPhase: stableNoise(`${plot.node.id}:phase`) * Math.PI * 2,
      bobSeed: stableNoise(`${plot.node.id}:bob`) * Math.PI * 2,
      awayFromHome: false,
      stuckTime: 0,
      lastX: home.x,
      lastZ: home.z,
      greetTimer: 0,
      greetCooldownUntil: 0,
      workKind: null,
      workTimer: 0,
      pendingWork: null,
      speed: WALK_SPEED * (0.85 + stableNoise(`${plot.node.id}:pace`) * 0.3),
    };

    // Resume exactly where this agent was before the rebuild (theme switches,
    // incremental graph updates) instead of teleporting everyone home.
    const saved = options.restore?.get(plot.node.filePath);
    if (saved) {
      agent.position.copy(saved.position);
      agent.heading = saved.heading;
      agent.targetHeading = saved.targetHeading;
      agent.state = saved.state;
      agent.waypoints = saved.waypoints.map((point) => point.clone());
      agent.waypointIndex = saved.waypointIndex;
      agent.restTimer = saved.restTimer;
      agent.walkPhase = saved.walkPhase;
      agent.awayFromHome = saved.awayFromHome;
      agent.workKind = saved.workKind;
      agent.workTimer = saved.workTimer;
      agent.pendingWork = saved.pendingWork ? { ...saved.pendingWork } : null;
    }

    agents.push(agent);
    byFilePath.set(plot.node.filePath, agent);
  }

  // ── Routing ──

  function routeTo(
    agent: AgentRuntime,
    destination: Vector3,
    viaIsland: IslandSpec | null,
  ): boolean {
    const from = agent.position.clone();
    const homeIsland = agent.plot.island;
    const points: Vector3[] = [];

    if (!viaIsland || viaIsland.clusterIndex === homeIsland.clusterIndex) {
      // Same island: walk directly, only occasionally swinging by the plaza —
      // otherwise everyone funnels into the island center.
      if (from.distanceTo(destination) > (PLAZA_RADIUS + 4) * BLOCK && Math.random() < 0.25) {
        points.push(plazaPoint(homeIsland));
      }
      points.push(destination);
    } else {
      const bridge = bridges.get(bridgeKey(homeIsland.clusterIndex, viaIsland.clusterIndex));
      if (!bridge) return false;
      const forward = bridge.clusterA === homeIsland.clusterIndex;
      const nearEnd = forward ? bridge.start : bridge.end;
      const farEnd = forward ? bridge.end : bridge.start;
      points.push(nearEnd.clone(), farEnd.clone());
      points.push(destination);
    }

    routeAlong(agent, points);
    return true;
  }

  // ── Behaviour repertoire ──

  /** A point in a small radius around the agent's own front yard. */
  function nearHomePoint(agent: AgentRuntime): Vector3 {
    const island = agent.plot.island;
    const angle = Math.random() * Math.PI * 2;
    const radius = BLOCK * (1 + Math.random() * 2.2);
    const point = new Vector3(
      agent.home.x + Math.cos(angle) * radius,
      island.elevation * BLOCK,
      agent.home.z + Math.sin(angle) * radius,
    );
    // Keep it on the island.
    const maxRing = (island.radiusBlocks - 3) * BLOCK;
    const offset = point.clone().sub(island.center);
    offset.y = 0;
    if (offset.length() > maxRing) {
      offset.setLength(maxRing);
      point.set(island.center.x + offset.x, point.y, island.center.z + offset.z);
    }
    return point;
  }

  /** A spot on the grassy ring just inside the beach — shoreline strolls. */
  function shorePoint(island: IslandSpec, baseAngle?: number): Vector3 {
    const angle = baseAngle ?? Math.random() * Math.PI * 2;
    const radius = (island.radiusBlocks - 4) * BLOCK;
    return new Vector3(
      island.center.x + Math.cos(angle) * radius,
      island.elevation * BLOCK,
      island.center.z + Math.sin(angle) * radius,
    );
  }

  /** Multi-leg patrol along the island perimeter — knights and rangers. */
  function patrolRoute(agent: AgentRuntime): Vector3[] {
    const island = agent.plot.island;
    const start = Math.atan2(
      agent.position.z - island.center.z,
      agent.position.x - island.center.x,
    );
    const direction = Math.random() < 0.5 ? 1 : -1;
    const legs = 2 + Math.floor(Math.random() * 3);
    const points: Vector3[] = [];
    for (let leg = 1; leg <= legs; leg++) {
      points.push(shorePoint(island, start + direction * leg * (Math.PI / 3)));
    }
    return points;
  }

  function tryVisitLinkedNote(agent: AgentRuntime): boolean {
    const neighbours = adjacencyMap[agent.node.filePath] ?? [];
    const candidates = neighbours.filter((filePath) => {
      const targetPlot = plots.get(filePath);
      if (!targetPlot) return false;
      if (targetPlot.island.clusterIndex === agent.plot.island.clusterIndex) return true;
      return bridges.has(bridgeKey(agent.plot.island.clusterIndex, targetPlot.island.clusterIndex));
    });
    if (candidates.length === 0) return false;
    const targetPath = candidates[Math.floor(Math.random() * candidates.length)];
    const targetPlot = plots.get(targetPath);
    const door = options.doorPosition(targetPath);
    if (!targetPlot || !door) return false;
    const spot = door.clone();
    spot.x += (Math.random() - 0.5) * BLOCK;
    spot.z += (Math.random() - 0.5) * BLOCK;
    pushOutOfHouses(spot);
    return routeTo(agent, spot, targetPlot.island);
  }

  // ── Work assignments ──
  //
  // Each class has a visible job at a real village prop: peasants hoe the
  // crop fields, villagers man the market stalls, rangers cut firewood,
  // wizards study at home, knights run sword drills by the plaza, and nobles
  // inspect the markets and the well.

  const workSites = options.workSites ?? { fields: [], stalls: [], wells: [], trees: [] };

  /** Routes the agent to a class-appropriate work site. Null if none exist. */
  function tryStartWork(agent: AgentRuntime): WorkKind | null {
    const island = agent.plot.island;
    const cls = agent.look.agentClass;

    if (cls === "peasant") {
      const field = siteOnIsland(workSites.fields, island.clusterIndex);
      if (!field) return null;
      // Scatter workers across the field, not onto one tile.
      const angle = Math.random() * Math.PI * 2;
      const reach = 2.2 + Math.random() * 2.6;
      const spot = field.position.clone();
      spot.x += Math.cos(angle) * reach;
      spot.z += Math.sin(angle) * reach;
      pushOutOfHouses(spot);
      agent.pendingWork = { kind: "farm", faceHeading: Math.random() * Math.PI * 2 };
      return routeTo(agent, spot, island) ? "farm" : null;
    }

    if (cls === "villager") {
      const stall = siteOnIsland(workSites.stalls, island.clusterIndex);
      if (!stall) return null;
      // Stand behind the counter at an agent-specific slot along its width,
      // so several sellers line up instead of stacking on one point.
      const lateral = (stableNoise(`${agent.node.id}:stallslot`) - 0.5) * 4.6;
      const spot = stall.position.clone();
      spot.x += -Math.sin(stall.rotY) * 2.6 + Math.cos(stall.rotY) * lateral;
      spot.z += -Math.cos(stall.rotY) * 2.6 - Math.sin(stall.rotY) * lateral;
      agent.pendingWork = { kind: "sell", faceHeading: stall.rotY };
      return routeTo(agent, spot, island) ? "sell" : null;
    }

    if (cls === "ranger") {
      const tree = siteOnIsland(workSites.trees, island.clusterIndex);
      if (!tree) return null;
      const angle = Math.random() * Math.PI * 2;
      const spot = tree.position.clone();
      spot.x += Math.cos(angle) * 2.6;
      spot.z += Math.sin(angle) * 2.6;
      pushOutOfHouses(spot);
      agent.pendingWork = {
        kind: "chop",
        faceHeading: Math.atan2(tree.position.x - spot.x, tree.position.z - spot.z),
      };
      return routeTo(agent, spot, island) ? "chop" : null;
    }

    if (cls === "wizard") {
      agent.pendingWork = { kind: "study", faceHeading: agent.plot.rotationY + Math.PI };
      routeAlong(agent, [nearHomePoint(agent)]);
      return "study";
    }

    if (cls === "knight") {
      const angle = Math.random() * Math.PI * 2;
      const ring = (PLAZA_RADIUS + 1.8 + Math.random() * 1.8) * BLOCK;
      const spot = new Vector3(
        island.center.x + Math.cos(angle) * ring,
        island.elevation * BLOCK,
        island.center.z + Math.sin(angle) * ring,
      );
      pushOutOfHouses(spot);
      agent.pendingWork = { kind: "drill", faceHeading: angle + Math.PI / 2 };
      return routeTo(agent, spot, island) ? "drill" : null;
    }

    // Nobles inspect a stall or the well.
    const target =
      siteOnIsland(workSites.stalls, island.clusterIndex) ??
      siteOnIsland(workSites.wells, island.clusterIndex);
    if (!target) return null;
    const facing = target.rotY + (Math.random() - 0.5) * 0.9;
    const spot = target.position.clone();
    spot.x += Math.sin(facing) * (4 + Math.random() * 2);
    spot.z += Math.cos(facing) * (4 + Math.random() * 2);
    pushOutOfHouses(spot);
    agent.pendingWork = {
      kind: "inspect",
      faceHeading: Math.atan2(target.position.x - spot.x, target.position.z - spot.z),
    };
    return routeTo(agent, spot, island) ? "inspect" : null;
  }

  /**
   * Per-class behaviour weights: [visit link, plaza, shore stroll, patrol,
   * roam island, work]. Whatever is left falls through to puttering at home.
   */
  const BEHAVIOUR_WEIGHTS: Record<AgentClass, [number, number, number, number, number, number]> = {
    knight: [0.14, 0.05, 0.05, 0.28, 0.08, 0.25],
    ranger: [0.12, 0.03, 0.18, 0.16, 0.12, 0.28],
    wizard: [0.18, 0.05, 0.04, 0, 0.08, 0.45],
    noble: [0.2, 0.14, 0.06, 0, 0.1, 0.28],
    peasant: [0.08, 0.06, 0.06, 0, 0.12, 0.48],
    villager: [0.14, 0.1, 0.08, 0, 0.14, 0.32],
  };

  function decide(agent: AgentRuntime): void {
    agent.pendingWork = null;
    if (agent.awayFromHome) {
      // Head home after an outing.
      agent.awayFromHome = false;
      routeTo(agent, agent.home.clone(), agent.plot.island);
      return;
    }

    // After dark most folk stay around the hearth; only the watch (knights
    // and rangers) keeps its full routine.
    const cls = agent.look.agentClass;
    if (palette.mood === "night" && cls !== "knight" && cls !== "ranger" && Math.random() < 0.55) {
      if (Math.random() < 0.5) routeAlong(agent, [nearHomePoint(agent)]);
      else agent.restTimer = 3 + Math.random() * 7;
      return;
    }

    const island = agent.plot.island;
    const weights = BEHAVIOUR_WEIGHTS[agent.look.agentClass];
    let roll = Math.random();
    const pick = (weight: number) => {
      if (roll < weight) return true;
      roll -= weight;
      return false;
    };

    if (pick(weights[0]) && tryVisitLinkedNote(agent)) {
      agent.awayFromHome = true;
      return;
    }
    if (pick(weights[1])) {
      routeTo(agent, plazaPoint(island), island);
      agent.awayFromHome = true;
      return;
    }
    if (pick(weights[2])) {
      routeTo(agent, shorePoint(island), island);
      agent.awayFromHome = true;
      return;
    }
    if (pick(weights[3])) {
      routeAlong(agent, patrolRoute(agent));
      agent.awayFromHome = true;
      return;
    }
    if (pick(weights[4])) {
      routeTo(agent, wanderPoint(island), island);
      agent.awayFromHome = true;
      return;
    }
    if (pick(weights[5])) {
      const startedKind = tryStartWork(agent);
      if (startedKind) {
        agent.awayFromHome = startedKind !== "study";
        return;
      }
    }
    if (Math.random() < 0.6) {
      // Putter around the front yard without leaving home.
      routeAlong(agent, [nearHomePoint(agent)]);
      return;
    }
    // Stay put a little longer.
    agent.restTimer = 2 + Math.random() * 6;
  }

  // ── Collisions: separation steering, greetings, house keep-out ──

  const cellSize = SEPARATION_BASE * 1.6;
  const grid = new Map<string, number[]>();

  function onBridge(agent: AgentRuntime): boolean {
    return agent.position.y < agent.plot.island.elevation * BLOCK - 1.5;
  }

  /** Two characters that bump mid-journey stop and greet each other. */
  function maybeGreet(agent: AgentRuntime, other: AgentRuntime, nowSeconds: number): void {
    if (agent.greetTimer > 0 || other.greetTimer > 0) return;
    if (nowSeconds < agent.greetCooldownUntil || nowSeconds < other.greetCooldownUntil) return;
    if (agent.state !== "walk" && other.state !== "walk") return;
    // Most bumps are just shoulder-past moments; only some become greetings,
    // otherwise busy plazas turn into standing crowds.
    if (Math.random() > 0.35) {
      agent.greetCooldownUntil = nowSeconds + 5;
      other.greetCooldownUntil = nowSeconds + 5;
      return;
    }

    const duration = GREET_SECONDS_MIN + Math.random() * GREET_SECONDS_VAR;
    agent.greetTimer = duration;
    other.greetTimer = duration;
    agent.greetCooldownUntil = nowSeconds + GREET_COOLDOWN_MIN + Math.random() * GREET_COOLDOWN_VAR;
    other.greetCooldownUntil = nowSeconds + GREET_COOLDOWN_MIN + Math.random() * GREET_COOLDOWN_VAR;
    // Face each other for the exchange.
    agent.targetHeading = Math.atan2(
      other.position.x - agent.position.x,
      other.position.z - agent.position.z,
    );
    other.targetHeading = agent.targetHeading + Math.PI;
  }

  function applyCollisions(nowSeconds: number): void {
    grid.clear();
    for (const [index, agent] of agents.entries()) {
      if (onBridge(agent)) continue;
      const key = `${Math.floor(agent.position.x / cellSize)}:${Math.floor(agent.position.z / cellSize)}`;
      const bucket = grid.get(key);
      if (bucket) bucket.push(index);
      else grid.set(key, [index]);
    }

    // Two resolution passes: in a crowd a single pass leaves residual
    // overlap (each pair only resolves half), which read as a merged blob.
    for (let pass = 0; pass < 2; pass++) {
      for (const [index, agent] of agents.entries()) {
        if (onBridge(agent)) continue;
        const cellX = Math.floor(agent.position.x / cellSize);
        const cellZ = Math.floor(agent.position.z / cellSize);
        for (let nx = cellX - 1; nx <= cellX + 1; nx++) {
          for (let nz = cellZ - 1; nz <= cellZ + 1; nz++) {
            const bucket = grid.get(`${nx}:${nz}`);
            if (!bucket) continue;
            for (const otherIndex of bucket) {
              if (otherIndex <= index) continue;
              const other = agents[otherIndex];
              const minDist = SEPARATION_BASE * ((agent.look.scale + other.look.scale) / 2);
              let dx = other.position.x - agent.position.x;
              let dz = other.position.z - agent.position.z;
              let dist = Math.hypot(dx, dz);
              if (dist >= minDist) continue;
              if (dist < 0.001) {
                // Exact overlap: split along a deterministic direction.
                const angle = (index * 2.399963 + otherIndex) % (Math.PI * 2);
                dx = Math.cos(angle);
                dz = Math.sin(angle);
                dist = 1;
              }
              const push = (minDist - Math.min(dist, minDist)) / 2;
              const inv = 1 / dist;
              agent.position.x -= dx * inv * push;
              agent.position.z -= dz * inv * push;
              other.position.x += dx * inv * push;
              other.position.z += dz * inv * push;
              if (pass === 0) maybeGreet(agent, other, nowSeconds);
            }
          }
        }
      }
    }

    // Houses are hard obstacles: anyone inside a house circle slides out
    // along its edge, which doubles as walking around the building.
    for (const agent of agents) {
      if (onBridge(agent)) continue;
      pushOutOfHouses(agent.position, HOUSE_RADIUS);
    }
  }

  // ── Character rendering ──
  //
  // Each agent owns 16 instance slots. Slots a class does not use stay hidden.
  // All offsets are in the agent's local space: +Z is forward.

  const partPosition = new Vector3();
  const tints = new Map<string, string>();

  function writeAgent(
    agent: AgentRuntime,
    nowSeconds: number,
    moving: boolean,
    greeting: boolean,
  ): void {
    const { look } = agent;
    const cls = look.agentClass;
    const scale = look.scale;
    const swing = moving ? Math.sin(agent.walkPhase) : 0;
    const bob = moving
      ? Math.abs(Math.sin(agent.walkPhase)) * 0.5
      : Math.sin(nowSeconds * 1.9 + agent.bobSeed) * 0.16 + 0.16;
    const wave = greeting ? Math.sin(nowSeconds * 9 + agent.bobSeed) * 0.35 : 0;
    const working = !greeting && agent.state === "work" ? agent.workKind : null;
    // Shared work rhythm: hoeing, chopping and sword drills all swing on it.
    const labor = Math.sin(nowSeconds * 5.5 + agent.bobSeed);
    const cos = Math.cos(agent.heading);
    const sin = Math.sin(agent.heading);
    const tint = tints.get(agent.node.filePath) ?? null;
    let slot = 0;

    const place = (
      lx: number,
      ly: number,
      lz: number,
      sx: number,
      sy: number,
      sz: number,
      color: string,
    ) => {
      partPosition.set(
        agent.position.x + (lx * cos + lz * sin) * scale,
        agent.position.y + (ly + bob) * scale,
        agent.position.z + (-lx * sin + lz * cos) * scale,
      );
      batch.set(agent.firstInstance + slot, {
        x: partPosition.x,
        y: partPosition.y,
        z: partPosition.z,
        sx: sx * scale,
        sy: sy * scale,
        sz: sz * scale,
        rotY: agent.heading,
        color: tint ?? color,
      });
      slot += 1;
    };

    const isRobed = cls === "wizard";
    let legColor = look.pants;
    if (cls === "knight") legColor = STEEL_DARK;
    else if (isRobed) legColor = look.robe;
    let torsoColor = look.tunic;
    if (cls === "knight") torsoColor = STEEL;
    else if (cls === "wizard" || cls === "noble") torsoColor = look.robe;
    else if (cls === "ranger") torsoColor = look.leather;
    const armColor = cls === "knight" ? STEEL_DARK : torsoColor;

    // Legs with boots (robes hide the boots).
    place(-0.62, 1.2 + Math.max(0, swing) * 0.3, swing * 0.85, 1, 2, 1.1, legColor);
    place(0.62, 1.2 + Math.max(0, -swing) * 0.3, -swing * 0.85, 1, 2, 1.1, legColor);
    if (!isRobed) {
      place(-0.62, 0.4 + Math.max(0, swing) * 0.3, swing, 1.1, 0.8, 1.3, BOOT);
      place(0.62, 0.4 + Math.max(0, -swing) * 0.3, -swing, 1.1, 0.8, 1.3, BOOT);
    }

    // Torso — wizards wear long robes.
    if (isRobed) {
      place(0, 2.9, 0, 3.3, 4.4, 2.1, look.robe);
    } else {
      place(0, 3.7, 0, 3, 3, 1.8, torsoColor);
    }

    // Belt.
    let beltColor = BOOT;
    if (cls === "noble") beltColor = GOLD;
    else if (cls === "wizard") beltColor = ROPE;
    place(0, 2.45, 0, isRobed ? 3.4 : 3.1, 0.5, isRobed ? 2.2 : 1.9, beltColor);

    // Arms: walk counter-swing by default, with greeting and work poses.
    if (greeting) {
      place(-1.95, 3.9, -swing * 0.9, 0.9, 2.6, 1, armColor);
      place(1.95, 5.6 + wave, 0.2, 0.9, 2.6, 1, armColor);
    } else if (working === "farm" || working === "chop") {
      // Two hands on the tool, swinging with the labor rhythm.
      place(-1.7, 3.5 - Math.max(0, labor) * 0.4, 0.9, 0.9, 2.4, 1, armColor);
      place(1.7, 3.5 - Math.max(0, labor) * 0.4, 0.9 + labor * 0.4, 0.9, 2.4, 1, armColor);
    } else if (working === "sell") {
      // Hands resting on the counter; an occasional wave at customers.
      const hail = Math.sin(nowSeconds * 0.9 + agent.bobSeed) > 0.55;
      place(-1.95, 3.4, 0.7, 0.9, 2.2, 1, armColor);
      if (hail) {
        place(1.95, 5.6 + Math.sin(nowSeconds * 9) * 0.3, 0.2, 0.9, 2.6, 1, armColor);
      } else {
        place(1.95, 3.4, 0.7, 0.9, 2.2, 1, armColor);
      }
    } else if (working === "study") {
      // Both hands up holding the book.
      place(-1.8, 4.3, 0.8, 0.9, 2.2, 1, armColor);
      place(
        1.8,
        4.3 + Math.sin(nowSeconds * 1.6 + agent.bobSeed) * 0.15,
        0.8,
        0.9,
        2.2,
        1,
        armColor,
      );
    } else if (working === "drill") {
      // Sword arm slashing, off arm guarding.
      place(-1.95, 4.1, -0.5, 0.9, 2.4, 1, armColor);
      place(1.95, 4.2, Math.sin(nowSeconds * 6 + agent.bobSeed) * 1.2, 0.9, 2.6, 1, armColor);
    } else if (working === "inspect") {
      // Hands clasped behind the back.
      place(-1.6, 3.7, -1, 0.9, 2.4, 1, armColor);
      place(1.6, 3.7, -1, 0.9, 2.4, 1, armColor);
    } else {
      place(-1.95, 3.9, -swing * 0.9, 0.9, 2.6, 1, armColor);
      place(1.95, 3.9, swing * 0.9, 0.9, 2.6, 1, armColor);
    }

    // Head.
    place(0, 6.5, 0, 2.6, 2.6, 2.6, look.skin);

    // Hair / headgear per class.
    if (cls === "knight") {
      place(0, 6.6, 0, 2.9, 2.9, 2.9, STEEL); // full helm
      place(0, 6.55, 1.5, 1.9, 0.5, 0.2, "#1c2430"); // visor slit
      place(0, 8.3, -0.2, 0.7, 1.1, 1.9, look.accent); // plume
    } else if (cls === "wizard") {
      place(0, 8, 0, 3.6, 0.55, 3.6, look.robe); // brim
      place(0, 9.2, 0, 1.7, 2.2, 1.7, look.robe); // cone
      place(0, 9.1, 0.95, 0.6, 0.6, 0.2, GOLD); // star charm
    } else if (cls === "ranger") {
      place(0, 7.9, -0.3, 2.9, 1, 3.1, look.leather); // hood top
      place(0, 6.4, -1.5, 2.9, 2.6, 0.6, look.leather); // hood back
    } else if (cls === "noble") {
      place(0, 8, -0.15, 2.8, 0.9, 2.8, look.hair);
      place(0, 8.7, 0, 2, 0.7, 2, GOLD); // crown
      place(0, 5.05, 1, 1.5, 0.4, 0.3, GOLD); // necklace
    } else if (cls === "peasant") {
      place(0, 8, 0, 3.6, 0.5, 3.6, STRAW); // straw brim
      place(0, 8.5, 0, 1.9, 0.7, 1.9, STRAW);
    } else {
      place(0, 8, -0.15, 2.8, 1, 2.8, look.hair);
    }

    // Cosmetic extras rolled per agent.
    if (look.beard && cls !== "knight") {
      if (cls === "wizard") {
        place(0, 4.9, 1.3, 1.9, 2.4, 0.6, look.beard); // sage beard
      } else {
        place(0, 5.5, 1.25, 1.7, 1.1, 0.5, look.beard);
      }
    }
    if (look.longHair && cls !== "knight" && cls !== "ranger") {
      place(0, 6.8, -1.5, 2.4, 2.6, 0.6, look.hair);
    }
    if (look.pouch) {
      place(1.35, 2.5, 0.8, 0.8, 1.1, 0.7, BOOT);
    }
    if (look.backpack) {
      place(0, 4.2, -1.35, 2.1, 2.4, 1, look.leather);
    }
    if (look.emblem) {
      place(0, 4.4, 0.95, 0.9, 0.9, 0.25, GOLD);
    }

    // Hands: weapons & tools, held at the right hand and moving with it.
    const handZ = swing * 0.9;
    if (cls === "knight") {
      const drillZ = working === "drill" ? Math.sin(nowSeconds * 6 + agent.bobSeed) * 1.2 : handZ;
      const drillY = working === "drill" ? 4 : 2.9;
      place(2.55, drillY, drillZ, 0.5, 3.4, 0.7, BLADE); // sword
      place(2.55, drillY + 1.8, drillZ, 0.9, 0.3, 1.3, WOOD); // crossguard
      place(-2.6, 3.7, working === "drill" ? -0.5 : -swing * 0.9, 0.4, 2.7, 2.1, look.accent); // shield
    } else if (cls === "wizard") {
      if (working === "study") {
        // An open book replaces the staff while studying.
        place(0, 4.5, 1.45, 2.5, 1.7, 0.25, look.accent); // cover
        place(0, 4.55, 1.62, 2.2, 1.45, 0.18, "#ece6d4"); // pages
      } else {
        place(2.5, 4, handZ, 0.5, 7.4, 0.5, WOOD); // staff
        place(2.5, 7.9, handZ, 1.1, 1.1, 1.1, look.accent); // staff orb
      }
    } else if (cls === "ranger") {
      if (working === "chop") {
        // Woodcutting axe swinging at the tree.
        const chopY = 3.2 - Math.max(0, labor) * 0.5;
        const chopZ = 1 + labor * 0.55;
        place(2.2, chopY + 1, chopZ, 0.45, 3.8, 0.45, WOOD); // haft
        place(2.2, chopY + 2.7, chopZ + 0.45, 1.3, 0.9, 0.5, STEEL_DARK); // axe head
      } else {
        place(0.9, 5.2, -1.45, 1.4, 3.2, 0.6, WOOD); // quiver on the back
        place(0.9, 6.9, -1.45, 1, 0.6, 0.4, look.accent); // fletching
      }
    } else if (cls === "peasant") {
      if (working === "farm") {
        // Hoe held low, working the soil in front.
        const digY = 2.6 - Math.max(0, labor) * 0.45;
        const digZ = 1.5 + labor * 0.6;
        place(1.9, digY + 1.2, digZ, 0.45, 4.4, 0.45, WOOD); // shaft
        place(1.9, digY - 0.6, digZ + 0.7, 1.4, 0.5, 0.8, STEEL_DARK); // blade
      } else {
        place(2.5, 3.2, handZ, 0.45, 5.6, 0.45, WOOD); // pitchfork shaft
        place(2.5, 6.1, handZ, 1.5, 0.7, 0.45, STEEL_DARK); // tines
      }
    }

    // Capes for the martial classes, trailing slightly while walking.
    if (cls === "knight" || cls === "ranger" || cls === "noble") {
      const trail = moving ? 0.45 : 0.1;
      const capeColor = cls === "ranger" ? look.leather : look.accent;
      place(0, 3.6, -1.25 - trail * 0.4, 2.9, 4.2, 0.45, capeColor);
    }

    // Knight pauldrons.
    if (cls === "knight") {
      place(-1.95, 5.3, 0, 1.5, 0.9, 1.5, STEEL);
      place(1.95, 5.3, 0, 1.5, 0.9, 1.5, STEEL);
    }

    // Hide every unused slot for this class.
    for (; slot < PARTS_PER_AGENT; slot++) {
      batch.hide(agent.firstInstance + slot);
    }
  }

  function update(nowSeconds: number, deltaSeconds: number): void {
    for (const agent of agents) {
      if (agent.greetTimer > 0) {
        // Mid-greeting: stand still, keep turning toward the other agent.
        agent.greetTimer -= deltaSeconds;
      } else if (agent.state === "work") {
        agent.workTimer -= deltaSeconds;
        if (agent.workTimer <= 0) {
          agent.workKind = null;
          agent.state = "pause";
          agent.restTimer = 0.5 + Math.random() * 2;
        }
      } else if (agent.state === "walk") {
        const target = agent.waypoints[agent.waypointIndex];
        if (!target) {
          agent.state = "idle";
          agent.restTimer = 2 + Math.random() * 5;
        } else {
          const dx = target.x - agent.position.x;
          const dz = target.z - agent.position.z;
          const distance = Math.hypot(dx, dz);
          const step = agent.speed * deltaSeconds;
          if (distance <= step) {
            agent.position.copy(target);
            agent.waypointIndex += 1;
            if (agent.waypointIndex >= agent.waypoints.length) {
              startPendingWorkOrPause(agent);
            }
          } else {
            agent.targetHeading = Math.atan2(dx, dz);
            agent.position.x += (dx / distance) * step;
            agent.position.z += (dz / distance) * step;
            agent.position.y += (target.y - agent.position.y) * Math.min(1, deltaSeconds * 4);
            agent.walkPhase += deltaSeconds * 9;
          }
        }
      } else {
        agent.restTimer -= deltaSeconds;
        if (agent.restTimer <= 0) decide(agent);
        // Idle people glance around now and then.
        else if (Math.random() < deltaSeconds * 0.22) {
          agent.targetHeading = agent.heading + (Math.random() - 0.5) * 1.7;
        }
      }

      agent.heading +=
        shortestAngle(agent.heading, agent.targetHeading) * Math.min(1, deltaSeconds * TURN_SPEED);
    }

    applyCollisions(nowSeconds);

    for (const [index, agent] of agents.entries()) {
      // Stuck detection: a walker pinned against a house or a crowd for a
      // while gives up on the blocked waypoint and continues its route.
      const walking = agent.state === "walk" && agent.greetTimer <= 0;
      if (walking) {
        const moved = Math.hypot(agent.position.x - agent.lastX, agent.position.z - agent.lastZ);
        if (moved < agent.speed * deltaSeconds * 0.25) {
          agent.stuckTime += deltaSeconds;
          if (agent.stuckTime > STUCK_LIMIT_SECONDS) {
            agent.stuckTime = 0;
            agent.waypointIndex += 1;
            if (agent.waypointIndex >= agent.waypoints.length) {
              startPendingWorkOrPause(agent);
            }
          }
        } else {
          agent.stuckTime = 0;
        }
      } else {
        agent.stuckTime = 0;
      }
      agent.lastX = agent.position.x;
      agent.lastZ = agent.position.z;

      const moving = walking && agent.waypoints[agent.waypointIndex] !== undefined;
      writeAgent(agent, nowSeconds, moving, agent.greetTimer > 0);

      const shadowSize = 3.3 * agent.look.scale;
      shadows.set(index, {
        x: agent.position.x,
        y: agent.position.y + 0.18,
        z: agent.position.z,
        sx: shadowSize,
        sy: 0.12,
        sz: shadowSize,
        rotY: agent.heading,
        color: "#08101c",
      });
    }
    batch.commit();
    shadows.commit();
  }

  // ── Picking & highlight ──

  const nodeByInstance: (GraphNode | null)[] = Array.from(
    { length: agents.length * PARTS_PER_AGENT },
    () => null,
  );
  for (const agent of agents) {
    for (let part = 0; part < PARTS_PER_AGENT; part++) {
      nodeByInstance[agent.firstInstance + part] = agent.node;
    }
  }

  return {
    group,
    pickMesh: batch.mesh,
    nodeForInstance: (instanceId) => nodeByInstance[instanceId] ?? null,
    agentPosition: (filePath) => byFilePath.get(filePath)?.position.clone() ?? null,
    setTint: (filePath, tint) => {
      if (tint) tints.set(filePath, tint);
      else tints.delete(filePath);
    },
    update,
    snapshot: () => {
      const saved = new Map<string, AgentSnapshot>();
      for (const agent of agents) {
        saved.set(agent.node.filePath, {
          position: agent.position.clone(),
          heading: agent.heading,
          targetHeading: agent.targetHeading,
          state: agent.state,
          waypoints: agent.waypoints.map((point) => point.clone()),
          waypointIndex: agent.waypointIndex,
          restTimer: agent.restTimer,
          walkPhase: agent.walkPhase,
          awayFromHome: agent.awayFromHome,
          workKind: agent.workKind,
          workTimer: agent.workTimer,
          pendingWork: agent.pendingWork ? { ...agent.pendingWork } : null,
        });
      }
      return saved;
    },
    dispose: () => {
      batch.dispose();
      shadows.dispose();
    },
  };
}
