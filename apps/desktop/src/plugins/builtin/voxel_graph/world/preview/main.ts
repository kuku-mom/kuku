// ── Agent World — Standalone Preview Harness ──
//
// Dev-only entry point that renders the agent world with synthetic vault data,
// so the look can be iterated and screenshotted without the Tauri backend.
// Served at /world-preview.html by the Vite dev server. NOT bundled into the app.

import {
  Color,
  FogExp2,
  MOUSE,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import type { GraphLink, GraphNode, GraphState } from "~/plugins/builtin/graph_view/graph_types";

import { createAgentWorld } from "../engine";
import { paletteForMood, type WorldMood } from "../palette";
import { PainterlyRenderer } from "../postfx";

// ── Synthetic vault ──────────────────────────────────────────────

const CLUSTERS = ["Journal", "Projects", "Ideas", "People", "Reading", "Garden"];
const PER_CLUSTER = [9, 14, 7, 6, 5, 4];

function makeState(): GraphState {
  const nodes: GraphNode[] = [];
  const links: GraphLink[] = [];

  // Stress test: `?nodes=1500` (or `?big=1`) scales the synthetic vault up to
  // roughly that many notes, spread across the clusters, to measure load/perf.
  const requested = Number(new URLSearchParams(location.search).get("nodes"));
  const target =
    Number.isFinite(requested) && requested > 0
      ? requested
      : new URLSearchParams(location.search).get("big") !== null
        ? 1500
        : 0;
  const baseTotal = PER_CLUSTER.reduce((sum, n) => sum + n, 0);
  const scale = target > 0 ? Math.max(1, Math.round(target / baseTotal)) : 1;
  const perCluster = PER_CLUSTER.map((n) => n * scale);

  for (let c = 0; c < CLUSTERS.length; c++) {
    const folder = CLUSTERS[c];
    for (let i = 0; i < perCluster[c]; i++) {
      const filePath = `${folder}/note-${i}.md`;
      const lengths = [120, 900, 3200, 7800, 480, 1600];
      nodes.push({
        id: filePath,
        name: `${folder} note ${i + 1}`,
        filePath,
        folder,
        clusterIndex: c,
        linkCount: 0,
        isOrphan: false,
        documentLength: lengths[(c + i) % lengths.length],
      });
    }
  }

  // Wikilinks: chain within each cluster, plus a few bridges across clusters.
  const byCluster = new Map<number, GraphNode[]>();
  for (const node of nodes) {
    const list = byCluster.get(node.clusterIndex) ?? [];
    list.push(node);
    byCluster.set(node.clusterIndex, list);
  }
  for (const list of byCluster.values()) {
    for (let i = 1; i < list.length; i++) {
      links.push({ source: list[i - 1].filePath, target: list[i].filePath });
      if (i % 3 === 0 && i >= 3) {
        links.push({ source: list[i].filePath, target: list[i - 3].filePath });
      }
    }
  }
  // Cross-cluster bridges.
  const reps = [...byCluster.values()].map((list) => list[0]);
  for (let i = 1; i < reps.length; i++) {
    links.push({ source: reps[0].filePath, target: reps[i].filePath });
  }
  links.push({ source: reps[1].filePath, target: reps[2].filePath });
  links.push({ source: reps[2].filePath, target: reps[3].filePath });

  // Derive adjacency + linkCount.
  const adjacencyMap: Record<string, string[]> = {};
  for (const node of nodes) adjacencyMap[node.filePath] = [];
  for (const link of links) {
    adjacencyMap[link.source]?.push(link.target);
    adjacencyMap[link.target]?.push(link.source);
  }
  for (const node of nodes) {
    node.linkCount = adjacencyMap[node.filePath]?.length ?? 0;
    node.isOrphan = node.linkCount === 0;
  }

  return {
    nodes,
    links,
    adjacencyMap,
    clusters: CLUSTERS,
    isIndexing: false,
    lastIndexedAt: Date.now(),
    error: null,
  };
}

// ── Renderer ─────────────────────────────────────────────────────

const ISO_DIRECTION = new Vector3(1, 1.05, 1).normalize();
const params = new URLSearchParams(location.search);
const mood: WorldMood = params.get("mood") === "night" ? "night" : "day";

const host = document.getElementById("stage") as HTMLDivElement;

const renderer = new WebGLRenderer({ antialias: true });
renderer.outputColorSpace = SRGBColorSpace;
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
renderer.setSize(host.clientWidth, host.clientHeight);
host.appendChild(renderer.domElement);

const painterly = new PainterlyRenderer(renderer, [0.13, 0.12, 0.1]);
painterly.setSize(host.clientWidth, host.clientHeight);

const scene = new Scene();
const camera = new PerspectiveCamera(50, host.clientWidth / host.clientHeight, 4, 8_000);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.085;
controls.minPolarAngle = Math.PI * 0.18;
controls.maxPolarAngle = Math.PI * 0.33;
controls.enablePan = true;
controls.screenSpacePanning = false;
controls.mouseButtons = { LEFT: MOUSE.ROTATE, MIDDLE: MOUSE.PAN, RIGHT: MOUSE.PAN };

const state = makeState();
const engine = createAgentWorld({
  nodes: state.nodes,
  links: state.links,
  adjacencyMap: state.adjacencyMap,
  clusters: state.clusters,
  mood,
  compact: false,
  restoreAgents: undefined,
});
scene.add(engine.group);
scene.fog = new FogExp2(engine.palette.fog, engine.palette.fogDensity);
scene.background = new Color(engine.palette.fog);

const fitDistance = Math.max(180, engine.worldRadius * 1.4);
camera.position.copy(ISO_DIRECTION.clone().multiplyScalar(fitDistance));
controls.target.set(0, 7, 0);
camera.near = 4;
camera.far = Math.max(engine.worldRadius * 8, 6_000);
camera.updateProjectionMatrix();
controls.minDistance = engine.worldRadius * 0.1;
controls.maxDistance = Math.max(fitDistance * 1.25, engine.worldRadius * 1.6);
controls.update();

// Focus a note so banners/trails show.
engine.setFocus(state.nodes[10]?.filePath ?? null);

// Rolling FPS, read from preview_eval to measure perf at scale.
const perf = { fps: 0, nodes: state.nodes.length, frames: 0, accum: 0 };

// Expose for debugging from preview_eval.
(window as unknown as { __world: unknown }).__world = {
  engine,
  scene,
  camera,
  controls,
  state,
  perf,
  renderer,
  painterly,
  palette: paletteForMood(mood),
};

let last = 0;
function frame(now: number): void {
  requestAnimationFrame(frame);
  const delta = last === 0 ? 0.016 : (now - last) / 1000;
  last = now;
  perf.accum += delta;
  perf.frames += 1;
  if (perf.accum >= 0.5) {
    perf.fps = Math.round(perf.frames / perf.accum);
    perf.frames = 0;
    perf.accum = 0;
  }
  engine.update(now / 1000, Math.min(delta, 0.12));
  controls.update();
  const maxR = engine.worldRadius * 1.05;
  controls.target.x = Math.max(-maxR, Math.min(maxR, controls.target.x));
  controls.target.z = Math.max(-maxR, Math.min(maxR, controls.target.z));
  controls.target.y = Math.max(4, Math.min(26, controls.target.y));
  if (camera.position.y < 16) camera.position.y = 16;
  painterly.render(scene, camera);
}
requestAnimationFrame(frame);

window.addEventListener("resize", () => {
  painterly.setSize(host.clientWidth, host.clientHeight);
  camera.aspect = host.clientWidth / host.clientHeight;
  camera.updateProjectionMatrix();
});
