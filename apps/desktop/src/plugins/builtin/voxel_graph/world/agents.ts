// ── Agent World Agents ──
//
// One voxel adventurer per note, in classic medieval-RPG classes decided by
// the note's stats: well-linked hubs patrol as knights and nobles, long
// documents study as wizards, mid-linked notes scout as rangers, and the rest
// live as villagers and peasants. Agents wander their island, gather at the
// plaza, and cross bridges to visit notes they link to. Separation steering
// keeps characters from ever standing inside each other.

import {
  BoxGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  Quaternion,
  Vector3,
} from "three";

import type { GraphNode } from "~/plugins/builtin/graph_view/graph_types";

import type { WorkSite, WorkSites } from "./nature";

import {
  BLOCK,
  ISLAND_ELEVATION,
  PLAZA_RADIUS,
  stableNoise,
  type IslandSpec,
  type PlotSpec,
} from "../voxel_layout";
import { glowBatch, type VoxelBatch } from "./batch";
import {
  CHARACTER_FORWARD_OFFSET,
  loadCharacterModel,
  makeCharacterInstance,
  onCharacterModel,
  type CharacterInstance,
} from "./character_model";
import type { InteractionIndicatorAnchor } from "./indicators";
import { type WorldPalette } from "./palette";
import { type BridgeInfo } from "./paths";
import { noOutline } from "./toon";

export interface AgentsHandle {
  group: Group;
  pickMesh: InstancedMesh;
  nodeForInstance(instanceId: number): GraphNode | null;
  agentPosition(filePath: string): Vector3 | null;
  indicatorAnchor(filePath: string): InteractionIndicatorAnchor | null;
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
  state: AgentState;
  waypoints: Vector3[];
  waypointIndex: number;
  restTimer: number;
  walkPhase: number;
  awayFromHome: boolean;
  workKind: WorkKind | null;
  workTimer: number;
  pendingWork: PendingWork | null;
  pendingInside: boolean;
}

export type AgentWorldSnapshot = ReadonlyMap<string, AgentSnapshot>;

const DEFAULT_WALK_SPEED = 3.6;
const TURN_SPEED = 7;
/**
 * Hard cap on simulated, animated characters. Agents are decorative (every note
 * stays clickable via its house), so for large vaults we render a representative
 * subset — the busiest hubs plus a deterministic spread — instead of one skinned,
 * mixer-driven clone per note (which would mean thousands of per-frame updates).
 */
const DEFAULT_MAX_AGENTS = 120;
/** Personal space between two characters, scaled by their sizes. */
const SEPARATION_BASE = 4.2;
/** Keep-out radius around every house plot center (matches the GLB footprints). */
const HOUSE_RADIUS = 16;
/** The single flat height of the whole walkable countryside. Every agent is
 *  pinned here each frame so nobody can ever drop through the floor. */
const SURFACE_Y = ISLAND_ELEVATION * BLOCK;
/** Walking with almost no progress for this long skips the blocked waypoint. */
const STUCK_LIMIT_SECONDS = 0.85;
/** How long a character stays hidden after entering a house. */
const INSIDE_SECONDS_MIN = 1.6;
const INSIDE_SECONDS_VAR = 2.4;
const WORK_SECONDS_MIN = 3;
const WORK_SECONDS_VAR = 4;
const PAUSE_SECONDS_MIN = 0.6;
const PAUSE_SECONDS_VAR = 1.8;
const INITIAL_REST_SECONDS_MIN = 0.4;
const INITIAL_REST_SECONDS_VAR = 1.8;
const RETRY_IDLE_SECONDS_MIN = 0.4;
const RETRY_IDLE_SECONDS_VAR = 1.2;
const BLOCKED_RETRY_SECONDS_MIN = 0.2;
const BLOCKED_RETRY_SECONDS_VAR = 0.6;
const POST_INSIDE_IDLE_SECONDS_MIN = 0.25;
const POST_INSIDE_IDLE_SECONDS_VAR = 0.75;
const POST_WORK_PAUSE_SECONDS_MIN = 0.3;
const POST_WORK_PAUSE_SECONDS_VAR = 0.9;
const GATHER_LINGER_SECONDS_MIN = 2;
const GATHER_LINGER_SECONDS_VAR = 2.5;
const NIGHT_HOME_REST_SECONDS_MIN = 1;
const NIGHT_HOME_REST_SECONDS_VAR = 2.5;
const FALLBACK_REST_SECONDS_MIN = 0.8;
const FALLBACK_REST_SECONDS_VAR = 2.2;
/** How long a chance greeting lasts, and the cooldown before the next one. */
const GREET_SECONDS_MIN = 0.65;
const GREET_SECONDS_VAR = 0.55;
const GREET_CHANCE = 0.18;
const BUMP_COOLDOWN_SECONDS = 4;
const GREET_COOLDOWN_MIN = 14;
const GREET_COOLDOWN_VAR = 22;

export type AgentClass = "knight" | "wizard" | "ranger" | "noble" | "peasant" | "villager";

interface AgentLook {
  agentClass: AgentClass;
  scale: number;
}

export type AgentState = "idle" | "walk" | "pause" | "work" | "inside";

interface AgentRuntime {
  node: GraphNode;
  plot: PlotSpec;
  look: AgentLook;
  pickIndex: number;
  /** Which character variant this agent wears. */
  variant: number;
  /** The cloned, animated 3D model — null until the GLB finishes loading. */
  model: CharacterInstance | null;
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
  /** Follow the path height linearly across the current waypoint segment. */
  segIndex: number;
  segStartY: number;
  segLen: number;
  /** Remaining seconds of a greeting exchange; 0 when not greeting. */
  greetTimer: number;
  greetCooldownUntil: number;
  /** Current job while state === "work". */
  workKind: WorkKind | null;
  workTimer: number;
  /** Job to start once the current walk reaches its destination. */
  pendingWork: PendingWork | null;
  /** Enter and hide inside the next reached house doorway. */
  pendingInside: boolean;
  /** Personal walking pace — everyone moves a little differently. */
  speed: number;
  /** Seconds to linger at the next arrival (gathering/resting); 0 = default. */
  linger: number;
}

interface AgentsOptions {
  plots: ReadonlyMap<string, PlotSpec>;
  adjacencyMap: Record<string, string[]>;
  bridges: ReadonlyMap<string, BridgeInfo>;
  doorPosition(filePath: string): Vector3 | null;
  palette: WorldPalette;
  /** Village work sites (fields, stalls, wells, trees) agents can use. */
  workSites?: WorkSites;
  /** Hard cap on visible, simulated agents. */
  maxAgents?: number;
  /** Multiplier applied to the default walking speed. */
  speedMultiplier?: number;
  /** Restores agent positions/journeys from a previous world instance. */
  restore?: AgentWorldSnapshot;
}

function randomSeconds(min: number, variance: number): number {
  return min + Math.random() * variance;
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

function lookForNode(node: GraphNode, _island: IslandSpec, _palette: WorldPalette): AgentLook {
  return {
    agentClass: classForNode(node),
    // Tight variance so the cast reads as one consistent set of kids rather than
    // a jumble of mismatched sizes (the yellow-raincoat girl is shrunk separately).
    scale: 0.96 + stableNoise(`${node.id}:size`) * 0.08,
  };
}

function characterHeightScale(agent: AgentRuntime): number {
  // Variant 2 is intentionally child-sized to match its source GLB proportions.
  return agent.variant === 2 ? 0.82 : 1;
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
  agent.segIndex = -1;
  agent.state = "walk";
  agent.pendingInside = false;
}

function siteOnIsland(sites: readonly WorkSite[], clusterIndex: number): WorkSite | null {
  const local = sites.filter((site) => site.clusterIndex === clusterIndex);
  if (local.length === 0) return null;
  return local[Math.floor(Math.random() * local.length)];
}

/** At the end of a walk: clock in at the work site, or just take a break. */
function startPendingWorkOrPause(agent: AgentRuntime): void {
  if (agent.pendingInside) {
    agent.pendingInside = false;
    agent.pendingWork = null;
    agent.workKind = null;
    agent.workTimer = 0;
    agent.waypoints = [];
    agent.waypointIndex = 0;
    agent.greetTimer = 0;
    agent.state = "inside";
    agent.restTimer = randomSeconds(INSIDE_SECONDS_MIN, INSIDE_SECONDS_VAR);
    agent.targetHeading = agent.plot.rotationY + Math.PI;
    return;
  }
  if (agent.pendingWork) {
    agent.state = "work";
    agent.workKind = agent.pendingWork.kind;
    agent.workTimer = randomSeconds(WORK_SECONDS_MIN, WORK_SECONDS_VAR);
    agent.targetHeading = agent.pendingWork.faceHeading;
    agent.pendingWork = null;
    return;
  }
  agent.state = "pause";
  // Honour a requested linger (e.g. gathering in the square) for longer dwell;
  // otherwise a normal short breather.
  agent.restTimer =
    agent.linger > 0 ? agent.linger : randomSeconds(PAUSE_SECONDS_MIN, PAUSE_SECONDS_VAR);
  agent.linger = 0;
  agent.targetHeading = agent.heading + (Math.random() - 0.5) * 1.2;
}

function abandonBlockedWaypoint(agent: AgentRuntime): void {
  agent.pendingInside = false;
  agent.pendingWork = null;
  agent.workKind = null;
  agent.workTimer = 0;
  agent.waypoints = [];
  agent.waypointIndex = 0;
  agent.segIndex = -1;
  agent.linger = 0;
  agent.state = "idle";
  agent.restTimer = randomSeconds(BLOCKED_RETRY_SECONDS_MIN, BLOCKED_RETRY_SECONDS_VAR);
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
  const { plots, adjacencyMap, palette } = options;
  const maxAgents = Math.max(0, Math.floor(options.maxAgents ?? DEFAULT_MAX_AGENTS));
  const walkSpeed = DEFAULT_WALK_SPEED * Math.max(0.05, options.speedMultiplier ?? 1);
  const group = new Group();

  // Detailed rigged GLB characters: loaded once, then cloned per agent below.
  /** Character height in world units, scaled per agent — sizes model/pick/shadow. */
  const MODEL_HEIGHT = 9.4;
  loadCharacterModel(palette);

  // Pick the subset of notes that get a live wanderer. Below the cap, everyone
  // walks; above it, keep the highest-degree hubs first (a stable noise term
  // breaks ties and sprinkles in non-hubs so every island still feels inhabited).
  const activePaths = (() => {
    if (maxAgents <= 0) return new Set<string>();
    if (plots.size <= maxAgents) return null; // null ⇒ everyone is active
    const ranked = [...plots.values()].sort((a, b) => {
      const pa = a.node.linkCount + stableNoise(`${a.node.id}:active`);
      const pb = b.node.linkCount + stableNoise(`${b.node.id}:active`);
      return pb - pa;
    });
    return new Set(ranked.slice(0, maxAgents).map((plot) => plot.node.filePath));
  })();
  const agentCapacity = Math.max(1, Math.min(plots.size, maxAgents));

  // Invisible-but-raycastable pick proxy: one box instance per agent. A
  // raycaster skips objects with visible=false, so instead of hiding it we make
  // the material draw nothing (no color, no depth) while still being hit-tested.
  const pickGeometry = new BoxGeometry(1, 1, 1);
  const pickMaterial = new MeshBasicMaterial({ colorWrite: false, depthWrite: false });
  noOutline(pickMaterial);
  const pickMesh = new InstancedMesh(pickGeometry, pickMaterial, agentCapacity);
  pickMesh.frustumCulled = false;
  pickMesh.count = 0; // grown as agents are created
  group.add(pickMesh);

  // Soft blob shadow under every character — grounds them on the terrain
  // (matched to the houses' contact shadows so the cast reads as one scene).
  const shadows: VoxelBatch = glowBatch(agentCapacity, true, 0.28);
  shadows.reserve(agentCapacity);
  group.add(shadows.mesh);

  const agents: AgentRuntime[] = [];
  const byFilePath = new Map<string, AgentRuntime>();
  let disposed = false;

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

  // Plaza props (wells, stalls) are small solid structures — keep agents from
  // walking through them, with a tighter clearance than houses. Each carries its
  // own radius so agents can still walk up to the stall counter to "work".
  const props: { pos: Vector3; radius: number }[] = [
    ...(options.workSites?.wells ?? []).map((w) => ({ pos: w.position, radius: 3.4 })),
    ...(options.workSites?.stalls ?? []).map((s) => ({ pos: s.position, radius: 4.2 })),
  ];
  function pushOutOfProps(point: Vector3): Vector3 {
    for (const { pos: p, radius } of props) {
      const dx = point.x - p.x;
      const dz = point.z - p.z;
      const dist = Math.hypot(dx, dz);
      if (dist >= radius) continue;
      if (dist < 0.001) {
        point.x = p.x + radius;
        continue;
      }
      point.x = p.x + (dx / dist) * radius;
      point.z = p.z + (dz / dist) * radius;
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

  let pickCounter = 0;
  for (const plot of plots.values()) {
    if (activePaths && !activePaths.has(plot.node.filePath)) continue;
    const door = options.doorPosition(plot.node.filePath);
    const home = door ?? plot.position.clone();
    // Stand a little beside the walkway, facing the plaza like the house does.
    home.x += (stableNoise(`${plot.node.id}:hx`) - 0.5) * BLOCK * 1.6;
    home.z += (stableNoise(`${plot.node.id}:hz`) - 0.5) * BLOCK * 1.6;
    home.y = plot.position.y;
    pushOutOfHouses(home);

    const look = lookForNode(plot.node, plot.island, palette);

    const pickIndex = pickCounter;
    pickCounter += 1;

    const agent: AgentRuntime = {
      node: plot.node,
      plot,
      look,
      pickIndex,
      variant: Math.floor(stableNoise(`${plot.node.id}:variant`) * 4),
      model: null,
      home: home.clone(),
      position: home.clone(),
      heading: plot.rotationY + Math.PI,
      targetHeading: plot.rotationY + Math.PI,
      state: "idle",
      waypoints: [],
      waypointIndex: 0,
      restTimer:
        INITIAL_REST_SECONDS_MIN + stableNoise(`${plot.node.id}:rest`) * INITIAL_REST_SECONDS_VAR,
      walkPhase: stableNoise(`${plot.node.id}:phase`) * Math.PI * 2,
      bobSeed: stableNoise(`${plot.node.id}:bob`) * Math.PI * 2,
      awayFromHome: false,
      stuckTime: 0,
      lastX: home.x,
      lastZ: home.z,
      segIndex: -1,
      segStartY: home.y,
      segLen: 0,
      greetTimer: 0,
      greetCooldownUntil: 0,
      workKind: null,
      workTimer: 0,
      pendingWork: null,
      pendingInside: false,
      speed: walkSpeed * (0.85 + stableNoise(`${plot.node.id}:pace`) * 0.3),
      linger: 0,
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
      agent.pendingInside = saved.pendingInside ?? false;
    }

    agents.push(agent);
    byFilePath.set(plot.node.filePath, agent);
  }

  pickMesh.count = agents.length;

  // Once the GLB variants finish loading, give every agent its own animated clone.
  const unsubscribeCharacterModel = onCharacterModel(() => {
    if (disposed) return;
    for (const agent of agents) {
      const inst = makeCharacterInstance(
        agent.variant,
        MODEL_HEIGHT * agent.look.scale * characterHeightScale(agent),
      );
      if (inst) {
        agent.model = inst;
        group.add(inst.root);
      }
    }
  });

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
      // Same village: walk directly, occasionally swinging by the plaza so the
      // square stays lively instead of everyone cutting straight across.
      if (from.distanceTo(destination) > (PLAZA_RADIUS + 4) * BLOCK && Math.random() < 0.25) {
        points.push(plazaPoint(homeIsland));
      }
      points.push(destination);
    } else {
      // Different village on the same flat land: stroll out to the home village
      // edge, then straight across the countryside to the destination.
      const out = viaIsland.center.clone().sub(homeIsland.center);
      out.y = 0;
      if (out.lengthSq() > 0) {
        out.normalize();
        points.push(
          new Vector3(
            homeIsland.center.x + out.x * homeIsland.radiusBlocks * BLOCK * 0.8,
            destination.y,
            homeIsland.center.z + out.z * homeIsland.radiusBlocks * BLOCK * 0.8,
          ),
        );
      }
      points.push(destination);
    }

    routeAlong(agent, points);
    return true;
  }

  function routeInside(
    agent: AgentRuntime,
    destination: Vector3,
    viaIsland: IslandSpec | null,
  ): boolean {
    const routed = routeTo(agent, destination, viaIsland);
    if (routed) agent.pendingInside = true;
    return routed;
  }

  function routeAlongInside(agent: AgentRuntime, points: Vector3[]): void {
    routeAlong(agent, points);
    agent.pendingInside = true;
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

  /** A winding multi-leg stroll around the island — meander, don't beeline. */
  function strollRoute(agent: AgentRuntime): Vector3[] {
    const island = agent.plot.island;
    const legs = 2 + Math.floor(Math.random() * 3);
    const points: Vector3[] = [];
    for (let leg = 0; leg < legs; leg++) {
      points.push(Math.random() < 0.4 ? shorePoint(island) : wanderPoint(island));
    }
    points.push(agent.home.clone()); // amble back home at the end
    return points;
  }

  /** A spot in the village square where neighbours cluster and chat. */
  function gatherPoint(island: IslandSpec): Vector3 {
    const angle = Math.random() * Math.PI * 2;
    const radius = (PLAZA_RADIUS - 0.5 + Math.random() * 2.5) * BLOCK;
    return new Vector3(
      island.center.x + Math.cos(angle) * radius,
      island.elevation * BLOCK,
      island.center.z + Math.sin(angle) * radius,
    );
  }

  function tryVisitLinkedNote(agent: AgentRuntime): boolean {
    const neighbours = adjacencyMap[agent.node.filePath] ?? [];
    // Every linked note is reachable — it's all one continuous landmass now.
    const candidates = neighbours.filter((filePath) => plots.has(filePath));
    if (candidates.length === 0) return false;
    const targetPath = candidates[Math.floor(Math.random() * candidates.length)];
    const targetPlot = plots.get(targetPath);
    const door = options.doorPosition(targetPath);
    if (!targetPlot || !door) return false;
    const spot = door.clone();
    spot.x += (Math.random() - 0.5) * BLOCK;
    spot.z += (Math.random() - 0.5) * BLOCK;
    pushOutOfHouses(spot);
    return routeInside(agent, spot, targetPlot.island);
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
      spot.x += -Math.sin(stall.rotY) * 4.6 + Math.cos(stall.rotY) * lateral;
      spot.z += -Math.cos(stall.rotY) * 4.6 - Math.sin(stall.rotY) * lateral;
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
      routeInside(agent, agent.home.clone(), island);
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
   * roam island, work, meander stroll, gather in square]. Whatever is left
   * falls through to puttering at home.
   */
  const BEHAVIOUR_WEIGHTS: Record<
    AgentClass,
    [number, number, number, number, number, number, number, number]
  > = {
    knight: [0.12, 0.04, 0.04, 0.24, 0.06, 0.22, 0.08, 0.06],
    ranger: [0.1, 0.03, 0.14, 0.14, 0.08, 0.24, 0.1, 0.05],
    wizard: [0.16, 0.04, 0.03, 0, 0.06, 0.4, 0.06, 0.06],
    noble: [0.16, 0.12, 0.05, 0, 0.08, 0.24, 0.08, 0.1],
    peasant: [0.07, 0.05, 0.05, 0, 0.1, 0.42, 0.1, 0.06],
    villager: [0.12, 0.08, 0.07, 0, 0.12, 0.28, 0.12, 0.1],
  };

  function decide(agent: AgentRuntime): void {
    agent.pendingWork = null;
    if (agent.awayFromHome) {
      // Head home after an outing.
      agent.awayFromHome = false;
      routeInside(agent, agent.home.clone(), agent.plot.island);
      return;
    }

    // After dark most folk stay around the hearth; only the watch (knights
    // and rangers) keeps its full routine.
    const cls = agent.look.agentClass;
    if (palette.mood === "night" && cls !== "knight" && cls !== "ranger" && Math.random() < 0.55) {
      if (Math.random() < 0.35) routeInside(agent, agent.home.clone(), agent.plot.island);
      else if (Math.random() < 0.5) routeAlong(agent, [nearHomePoint(agent)]);
      else
        agent.restTimer = randomSeconds(NIGHT_HOME_REST_SECONDS_MIN, NIGHT_HOME_REST_SECONDS_VAR);
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
    if (pick(weights[6])) {
      // Winding stroll that ends back home, so they don't double-trip home.
      routeAlongInside(agent, strollRoute(agent));
      return;
    }
    if (pick(weights[7])) {
      // Gather in the square and linger a while — neighbours cluster up.
      agent.linger = randomSeconds(GATHER_LINGER_SECONDS_MIN, GATHER_LINGER_SECONDS_VAR);
      routeTo(agent, gatherPoint(island), island);
      agent.awayFromHome = true;
      return;
    }
    if (Math.random() < 0.2) {
      routeInside(agent, agent.home.clone(), island);
      return;
    }
    if (Math.random() < 0.6) {
      // Putter around the front yard without leaving home.
      routeAlong(agent, [nearHomePoint(agent)]);
      return;
    }
    // Stay put a little longer.
    agent.restTimer = randomSeconds(FALLBACK_REST_SECONDS_MIN, FALLBACK_REST_SECONDS_VAR);
  }

  // ── Collisions: separation steering, greetings, house keep-out ──

  const cellSize = SEPARATION_BASE * 1.6;
  const grid = new Map<string, number[]>();

  function onBridge(_agent: AgentRuntime): boolean {
    // No bridges on the flat mainland — everyone is always on solid ground.
    return false;
  }

  /** Two characters that bump mid-journey stop and greet each other. */
  function maybeGreet(agent: AgentRuntime, other: AgentRuntime, nowSeconds: number): void {
    if (agent.greetTimer > 0 || other.greetTimer > 0) return;
    if (nowSeconds < agent.greetCooldownUntil || nowSeconds < other.greetCooldownUntil) return;
    if (agent.state !== "walk" || other.state !== "walk") return;
    // Most bumps are just shoulder-past moments; only some become greetings,
    // otherwise busy plazas turn into standing crowds.
    if (Math.random() > GREET_CHANCE) {
      agent.greetCooldownUntil = nowSeconds + BUMP_COOLDOWN_SECONDS;
      other.greetCooldownUntil = nowSeconds + BUMP_COOLDOWN_SECONDS;
      return;
    }

    const duration = randomSeconds(GREET_SECONDS_MIN, GREET_SECONDS_VAR);
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
      if (agent.state === "inside" || onBridge(agent)) continue;
      const key = `${Math.floor(agent.position.x / cellSize)}:${Math.floor(agent.position.z / cellSize)}`;
      const bucket = grid.get(key);
      if (bucket) bucket.push(index);
      else grid.set(key, [index]);
    }

    // Two resolution passes: in a crowd a single pass leaves residual
    // overlap (each pair only resolves half), which read as a merged blob.
    for (let pass = 0; pass < 2; pass++) {
      for (const [index, agent] of agents.entries()) {
        if (agent.state === "inside" || onBridge(agent)) continue;
        const cellX = Math.floor(agent.position.x / cellSize);
        const cellZ = Math.floor(agent.position.z / cellSize);
        for (let nx = cellX - 1; nx <= cellX + 1; nx++) {
          for (let nz = cellZ - 1; nz <= cellZ + 1; nz++) {
            const bucket = grid.get(`${nx}:${nz}`);
            if (!bucket) continue;
            for (const otherIndex of bucket) {
              if (otherIndex <= index) continue;
              const other = agents[otherIndex];
              if (other.state === "inside") continue;
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
      if (agent.state === "inside" || onBridge(agent)) continue;
      pushOutOfHouses(agent.position, HOUSE_RADIUS);
      pushOutOfProps(agent.position);
    }
  }

  // ── Per-frame character transforms ──

  const pickMatrix = new Matrix4();
  const pickPosition = new Vector3();
  const pickQuaternion = new Quaternion();
  const pickScale = new Vector3();
  const hiddenPickMatrix = new Matrix4().makeScale(0, 0, 0);

  function update(nowSeconds: number, deltaSeconds: number): void {
    for (const agent of agents) {
      if (agent.greetTimer > 0) {
        // Mid-greeting: stand still, keep turning toward the other agent.
        agent.greetTimer -= deltaSeconds;
      } else if (agent.state === "inside") {
        agent.restTimer -= deltaSeconds;
        if (agent.restTimer <= 0) {
          agent.state = "idle";
          agent.restTimer = randomSeconds(
            POST_INSIDE_IDLE_SECONDS_MIN,
            POST_INSIDE_IDLE_SECONDS_VAR,
          );
          agent.targetHeading = agent.plot.rotationY + Math.PI;
        }
      } else if (agent.state === "work") {
        agent.workTimer -= deltaSeconds;
        if (agent.workTimer <= 0) {
          agent.workKind = null;
          agent.state = "pause";
          agent.restTimer = randomSeconds(POST_WORK_PAUSE_SECONDS_MIN, POST_WORK_PAUSE_SECONDS_VAR);
        }
      } else if (agent.state === "walk") {
        const target = agent.waypoints[agent.waypointIndex];
        if (!target) {
          agent.state = "idle";
          agent.restTimer = randomSeconds(RETRY_IDLE_SECONDS_MIN, RETRY_IDLE_SECONDS_VAR);
        } else {
          // Starting a new segment: record its start height + horizontal length
          // so the character's y follows the straight line to the next waypoint
          // (hugging ramps and bridge decks instead of lagging behind in the air).
          if (agent.segIndex !== agent.waypointIndex) {
            agent.segIndex = agent.waypointIndex;
            agent.segStartY = agent.position.y;
            agent.segLen = Math.max(
              0.001,
              Math.hypot(target.x - agent.position.x, target.z - agent.position.z),
            );
          }
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
            const progressed = Math.max(0, Math.min(1, 1 - distance / agent.segLen));
            agent.position.y = agent.segStartY + (target.y - agent.segStartY) * progressed;
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

      // The whole countryside is one flat plane; pin every agent to it so none
      // can ever sink through the ground.
      agent.position.y = SURFACE_Y;
    }

    applyCollisions(nowSeconds);

    for (const [index, agent] of agents.entries()) {
      // Stuck detection: a walker pinned against a house or a crowd for a
      // while gives up on the blocked waypoint and continues its route.
      const inside = agent.state === "inside";
      const walking = !inside && agent.state === "walk" && agent.greetTimer <= 0;
      if (walking) {
        const moved = Math.hypot(agent.position.x - agent.lastX, agent.position.z - agent.lastZ);
        if (moved < agent.speed * deltaSeconds * 0.25) {
          agent.stuckTime += deltaSeconds;
          if (agent.stuckTime > STUCK_LIMIT_SECONDS) {
            agent.stuckTime = 0;
            agent.waypointIndex += 1;
            if (agent.waypointIndex >= agent.waypoints.length) {
              abandonBlockedWaypoint(agent);
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

      // Drive the 3D character clone: stand at the agent's feet, face the
      // heading, and play the walk clip only while actually moving.
      const model = agent.model;
      if (model) {
        model.root.visible = !inside;
        if (!inside) {
          model.root.position.set(
            agent.position.x,
            agent.position.y + model.footOffset,
            agent.position.z,
          );
          model.root.rotation.y = agent.heading + CHARACTER_FORWARD_OFFSET;
        }
        model.setMoving(moving);
        model.update(deltaSeconds);
      }

      if (inside) {
        pickMesh.setMatrixAt(agent.pickIndex, hiddenPickMatrix);
        shadows.hide(index);
        continue;
      }

      // Pick proxy box centered on the body, scaled to cover the character.
      const bodyH = MODEL_HEIGHT * agent.look.scale;
      pickPosition.set(agent.position.x, agent.position.y + bodyH * 0.5, agent.position.z);
      pickQuaternion.identity();
      pickScale.set(bodyH * 0.5, bodyH, bodyH * 0.5);
      pickMatrix.compose(pickPosition, pickQuaternion, pickScale);
      pickMesh.setMatrixAt(agent.pickIndex, pickMatrix);

      const shadowSize = 3.9 * agent.look.scale;
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
    pickMesh.instanceMatrix.needsUpdate = true;
    shadows.commit();
  }

  // ── Picking & highlight ──

  const pickNode: (GraphNode | null)[] = Array.from({ length: agents.length }, () => null);
  const pickAgent: (AgentRuntime | null)[] = Array.from({ length: agents.length }, () => null);
  for (const agent of agents) {
    pickNode[agent.pickIndex] = agent.node;
    pickAgent[agent.pickIndex] = agent;
  }

  return {
    group,
    pickMesh,
    nodeForInstance: (id) => {
      const agent = pickAgent[id];
      if (agent?.state === "inside") return null;
      return pickNode[id] ?? null;
    },
    agentPosition: (filePath) => {
      const agent = byFilePath.get(filePath);
      if (!agent || agent.state === "inside") return null;
      return agent.position.clone();
    },
    indicatorAnchor: (filePath) => {
      const agent = byFilePath.get(filePath);
      if (!agent || agent.state === "inside") return null;
      return {
        position: agent.position.clone(),
        radius: 4.7 * agent.look.scale,
      };
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
          pendingInside: agent.pendingInside,
        });
      }
      return saved;
    },
    dispose: () => {
      disposed = true;
      unsubscribeCharacterModel();
      for (const agent of agents) agent.model?.dispose();
      pickMaterial.dispose();
      pickGeometry.dispose();
      pickMesh.dispose();
      shadows.dispose();
    },
  };
}
