import { residentProfile } from "./resident_profile";
import type { CurvedSurface } from "./curved_surface";
import { constrainToHarbor, harborBounds } from "./harbor_bounds";
// ── Agent World Agents ──
//
// Twenty-five voxel resident skins share independently animated rigs. Notes
// determine homes and postal destinations; walkable quay routes and separation
// steering keep residents outside buildings and the sea.

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
import {
  CHARACTER_FORWARD_OFFSET,
  characterVariantCount,
  HARBOR_RESIDENTS,
  loadCharacterModel,
  makeCharacterInstance,
  onCharacterModel,
  type CharacterInstance,
} from "./character_model";
import type { InteractionIndicatorAnchor } from "./indicators";
import { type WorldPalette } from "./palette";
import { type BridgeInfo } from "./paths";
import { noOutline } from "./toon";

export type ResidentActivity =
  | "delivering"
  | "handoff"
  | "returning"
  | "greeting"
  | "reading"
  | "working"
  | "walking"
  | "home"
  | "idle"
  | "complete";
export interface ResidentStatus {
  activity: ResidentActivity;
  targetName: string | null;
  canDeliver: boolean;
  label: string;
}
interface DeliveryState {
  targetPath: string;
  phase: "outbound" | "handoff" | "returning";
  remaining: number;
  elapsed: number;
}
interface ReactionState {
  kind: "wave" | "celebrate";
  remaining: number;
}

export interface AgentsHandle {
  group: Group;
  pickMesh: InstancedMesh;
  nodeForInstance(instanceId: number): GraphNode | null;
  agentPosition(filePath: string): Vector3 | null;
  residentLabelFor(filePath: string): string | null;
  statusFor(filePath: string): ResidentStatus | null;
  greet(filePath: string, viewerPosition?: Vector3): void;
  dispatch(filePath: string): boolean;
  cancelDelivery(filePath: string): void;
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
  delivery?: DeliveryState;
  reaction?: ReactionState;
  deliveriesCompleted?: number;
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
/** Broad-phase neighborhood radius around house plot centers. */
const HOUSE_RADIUS = 16;
/** The single flat height of the whole walkable quay. Every agent is
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
  delivery?: DeliveryState;
  reaction?: ReactionState;
  deliveriesCompleted?: number;
  node: GraphNode;
  plot: PlotSpec;
  look: AgentLook;
  pickIndex: number;
  /** Which character variant this agent wears. */
  variant: number;
  /** The cloned, independently animated procedural resident. */
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
  surface?: CurvedSurface;
  plots: ReadonlyMap<string, PlotSpec>;
  adjacencyMap: Record<string, string[]>;
  bridges: ReadonlyMap<string, BridgeInfo>;
  doorPosition(filePath: string): Vector3 | null;
  routeBetween?(from: Vector3, to: Vector3): Vector3[] | null;
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
    // Small personal variation combines with each silhouette’s distinct stature.
    scale: 0.96 + stableNoise(`${node.id}:size`) * 0.08,
  };
}

// ── Movement helpers ──────────────────────────────────────────

function shortestAngle(from: number, to: number): number {
  let delta = (to - from) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
}

function setRoute(agent: AgentRuntime, points: Vector3[]): void {
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

  // Articulated harbor residents: shared templates, independent animation per note.
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

  // Explicit raycasts use these proxies even though render passes skip them.
  const pickGeometry = new BoxGeometry(1, 1, 1);
  const pickMaterial = new MeshBasicMaterial({ colorWrite: false, depthWrite: false });
  noOutline(pickMaterial);
  const pickMesh = new InstancedMesh(pickGeometry, pickMaterial, agentCapacity);
  pickMesh.frustumCulled = false;
  pickMesh.visible = false; // Explicit raycasts still work; exclude proxies from render passes.
  pickMesh.count = 0; // grown as agents are created
  group.add(pickMesh);

  const quay = harborBounds([
    ...new Map([...plots.values()].map((p) => [p.island.clusterIndex, p.island])).values(),
  ]);
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
  const footprints = new Map<Vector3, { x: number; z: number }>();
  for (const plot of plots.values()) {
    footprints.set(plot.position, { x: plot.tier === 3 ? 21 : 12, z: plot.tier === 3 ? 16 : 11 });
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
      const footprint = footprints.get(house)!;
      const hx = footprint.x + clearance - HOUSE_RADIUS,
        hz = footprint.z + clearance - HOUSE_RADIUS;
      const dx = point.x - house.x,
        dz = point.z - house.z;
      if (Math.abs(dx) >= hx || Math.abs(dz) >= hz) continue;
      if (hx - Math.abs(dx) < hz - Math.abs(dz)) point.x = house.x + (dx < 0 ? -hx : hx);
      else point.z = house.z + (dz < 0 ? -hz : hz);
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
    look.scale *= residentProfile(agents.length % characterVariantCount()).stature;

    const pickIndex = pickCounter;
    pickCounter += 1;

    const agent: AgentRuntime = {
      node: plot.node,
      plot,
      look,
      pickIndex,
      variant: agents.length % characterVariantCount(),
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
      agent.delivery = saved.delivery ? { ...saved.delivery } : undefined;
      agent.reaction = saved.reaction ? { ...saved.reaction } : undefined;
      agent.deliveriesCompleted = saved.deliveriesCompleted ?? 0;
    }

    agents.push(agent);
    byFilePath.set(plot.node.filePath, agent);
  }

  pickMesh.count = agents.length;

  // Once the harbor templates are available, give every agent its own animated clone.
  const unsubscribeCharacterModel = onCharacterModel(() => {
    if (disposed) return;
    for (const agent of agents) {
      const inst = makeCharacterInstance(agent.variant, MODEL_HEIGHT * agent.look.scale);
      if (inst) inst.root.userData.filePath = agent.node.filePath;
      if (inst) {
        agent.model = inst;
        group.add(inst.root);
      }
    }
  });

  // ── Routing ──

  function routeAlong(agent: AgentRuntime, points: Vector3[]): void {
    if (!options.routeBetween) {
      setRoute(agent, points);
      return;
    }
    const route: Vector3[] = [];
    let from = agent.position;
    for (const target of points) {
      const leg = options.routeBetween(from, target);
      if (!leg) break;
      route.push(...leg.slice(1));
      from = target;
    }
    if (route.length) setRoute(agent, route);
    else {
      agent.state = "pause";
      agent.restTimer = 3;
    }
  }
  function routeTo(
    agent: AgentRuntime,
    destination: Vector3,
    _viaIsland: IslandSpec | null,
  ): boolean {
    const route = options.routeBetween?.(agent.position, destination);
    if (options.routeBetween && !route) return false;
    setRoute(agent, route?.slice(1) ?? [destination]);
    return true;
  }
  function greet(filePath: string, viewerPosition?: Vector3): void {
    const agent = byFilePath.get(filePath);
    if (!agent) return;
    if (agent.state === "inside") {
      agent.position.copy(agent.home);
      agent.state = "idle";
      agent.restTimer = 4;
    }
    if (viewerPosition) {
      // Camera is in rendered world space. Resolve its direction in the
      // resident's local tangent plane, including the island's curvature.
      const feet = options.surface?.project(agent.position) ?? agent.position.clone();
      const towardViewer = viewerPosition.clone().sub(feet);
      if (options.surface)
        towardViewer.applyQuaternion(options.surface.orientationAt(agent.position).invert());
      agent.targetHeading = Math.atan2(towardViewer.x, towardViewer.z) - CHARACTER_FORWARD_OFFSET;
    }
    agent.reaction = { kind: "wave", remaining: 2.4 };
    agent.greetTimer = 2.4;
  }
  function dispatch(filePath: string): boolean {
    const agent = byFilePath.get(filePath);
    if (!agent || agent.delivery) return false;
    const candidates = (adjacencyMap[filePath] ?? []).filter((p) => plots.has(p));
    if (!candidates.length) return false;
    const targetPath = candidates[(agent.deliveriesCompleted ?? 0) % candidates.length],
      door = options.doorPosition(targetPath);
    if (!door) return false;
    if (agent.state === "inside") {
      agent.position.copy(agent.home);
      agent.state = "idle";
    }
    if (!routeTo(agent, door, null)) return false;
    agent.pendingInside = false;
    agent.pendingWork = null;
    agent.greetTimer = 0;
    agent.reaction = undefined;
    agent.delivery = { targetPath, phase: "outbound", remaining: 0, elapsed: 0 };
    return true;
  }
  function cancelDelivery(filePath: string): void {
    const agent = byFilePath.get(filePath);
    if (!agent?.delivery) return;
    agent.delivery = undefined;
    agent.pendingInside = false;
    agent.pendingWork = null;
    routeTo(agent, agent.home, null);
  }
  function advanceScenario(agent: AgentRuntime, delta: number): void {
    if (agent.reaction) {
      agent.reaction.remaining -= delta;
      if (agent.reaction.remaining <= 0) agent.reaction = undefined;
    }
    const delivery = agent.delivery;
    if (!delivery) return;
    delivery.elapsed += delta;
    if (delivery.elapsed > 180) {
      cancelDelivery(agent.node.filePath);
      return;
    }
    if (delivery.phase === "handoff") {
      delivery.remaining -= delta;
      agent.state = "pause";
      agent.restTimer = 5;
      if (delivery.remaining <= 0) {
        delivery.phase = "returning";
        if (!routeTo(agent, agent.home, null)) cancelDelivery(agent.node.filePath);
      }
      return;
    }
    if (agent.state === "walk") return;
    const destination =
      delivery.phase === "returning" ? agent.home : options.doorPosition(delivery.targetPath);
    if (destination && agent.position.distanceTo(destination) > 7) {
      if (!routeTo(agent, destination, null)) cancelDelivery(agent.node.filePath);
      return;
    }
    if (delivery.phase === "outbound") {
      delivery.phase = "handoff";
      delivery.remaining = 2.6;
      agent.restTimer = 5;
      const receiver = byFilePath.get(delivery.targetPath);
      if (receiver) {
        greet(delivery.targetPath);
        receiver.targetHeading = Math.atan2(
          agent.position.x - receiver.position.x,
          agent.position.z - receiver.position.z,
        );
      }
    } else {
      agent.delivery = undefined;
      agent.deliveriesCompleted = (agent.deliveriesCompleted ?? 0) + 1;
      agent.reaction = { kind: "celebrate", remaining: 3 };
      agent.state = "idle";
      agent.restTimer = 8;
      agent.awayFromHome = false;
    }
  }
  function statusFor(filePath: string): ResidentStatus | null {
    const a = byFilePath.get(filePath);
    if (!a) return null;
    const activity: ResidentActivity = a.delivery
      ? a.delivery.phase === "outbound"
        ? "delivering"
        : a.delivery.phase
      : a.reaction
        ? a.reaction.kind === "celebrate"
          ? "complete"
          : "greeting"
        : a.greetTimer > 0
          ? "greeting"
          : a.state === "inside"
            ? "home"
            : a.state === "walk"
              ? "walking"
              : a.state === "work"
                ? a.workKind === "study"
                  ? "reading"
                  : "working"
                : "idle";
    return {
      activity,
      targetName: a.delivery ? (plots.get(a.delivery.targetPath)?.node.name ?? null) : null,
      canDeliver: !a.delivery && (adjacencyMap[filePath] ?? []).some((p) => plots.has(p)),
      label: HARBOR_RESIDENTS[a.variant],
    };
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
    return dispatch(agent.node.filePath);
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
    const guild = Math.floor(agent.variant / 5),
      island = agent.plot.island;
    const sites = guild === 3 ? workSites.trees : guild === 1 ? workSites.wells : workSites.stalls;
    const site = siteOnIsland(sites, island.clusterIndex);
    if (!site) return null;
    const kind: WorkKind =
      guild === 1 ? "study" : guild === 3 ? "farm" : guild === 4 ? "sell" : "inspect";
    const position = site.position.clone();
    pushOutOfHouses(position);
    agent.pendingWork = { kind, faceHeading: site.rotY };
    return routeTo(agent, position, island) ? kind : null;
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
    if (agent.delivery) return;
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

      // Navigation remains in chart coordinates; the render transform projects
      // these feet onto the sphere and aligns the body with its radial up.
      agent.position.y = SURFACE_Y;
    }

    for (const agent of agents) advanceScenario(agent, deltaSeconds);
    applyCollisions(nowSeconds);
    for (const agent of agents) constrainToHarbor(agent.position, quay);

    for (const agent of agents) {
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
          model.root.quaternion.setFromAxisAngle(
            new Vector3(0, 1, 0),
            agent.heading + CHARACTER_FORWARD_OFFSET,
          );
          if (options.surface) {
            options.surface.project(model.root.position, model.root.position);
            model.root.quaternion.premultiply(options.surface.orientationAt(agent.position));
          }
        }
        model.setMoving(moving);
        model.setAction(
          agent.reaction?.kind ??
            (agent.greetTimer > 0
              ? "wave"
              : agent.delivery
                ? agent.delivery.phase === "handoff"
                  ? "handoff"
                  : "carry"
                : agent.state === "work"
                  ? agent.workKind === "study"
                    ? "read"
                    : "work"
                  : "idle"),
        );
        model.update(deltaSeconds);
      }

      if (inside) {
        pickMesh.setMatrixAt(agent.pickIndex, hiddenPickMatrix);
        continue;
      }

      // Pick proxy box centered on the body, scaled to cover the character.
      const bodyH = MODEL_HEIGHT * agent.look.scale;
      pickPosition.set(agent.position.x, agent.position.y + bodyH * 0.5, agent.position.z);
      pickQuaternion.identity();
      pickScale.set(bodyH * 0.5, bodyH, bodyH * 0.5);
      pickMatrix.compose(pickPosition, pickQuaternion, pickScale);
      options.surface?.placeMatrix(pickMatrix);
      pickMesh.setMatrixAt(agent.pickIndex, pickMatrix);
    }
    pickMesh.instanceMatrix.needsUpdate = true;
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
    greet,
    dispatch,
    cancelDelivery,
    statusFor,
    residentLabelFor: (filePath) => {
      const agent = byFilePath.get(filePath);
      return agent ? HARBOR_RESIDENTS[agent.variant] : null;
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
          delivery: agent.delivery ? { ...agent.delivery } : undefined,
          reaction: agent.reaction ? { ...agent.reaction } : undefined,
          deliveriesCompleted: agent.deliveriesCompleted,
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
    },
  };
}
