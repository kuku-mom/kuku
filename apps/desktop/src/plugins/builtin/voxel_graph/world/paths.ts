/** Roof-to-roof graph arcs; postal navigation remains on walkable streets. */
import {
  BoxGeometry,
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Quaternion,
  QuadraticBezierCurve3,
  TubeGeometry,
  Vector3,
} from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { GraphLink } from "~/plugins/builtin/graph_view/graph_types";
import type { WorldPalette } from "./palette";
import type { IslandSpec, PlotSpec } from "../voxel_layout";
import { createMailRouter, type MailEndpoints } from "./mail_routes";
import type { CurvedSurface } from "./curved_surface";
export interface BridgeInfo {
  clusterA: number;
  clusterB: number;
  start: Vector3;
  end: Vector3;
}
export interface TrailPair extends MailEndpoints {}
export interface PathsHandle {
  group: Group;
  bridges: ReadonlyMap<string, BridgeInfo>;
  setFocusTrails(pairs: readonly TrailPair[]): void;
  routeBetween(from: Vector3, to: Vector3): Vector3[] | null;
  update(nowSeconds: number): void;
  dispose(): void;
}
export function bridgeKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}
interface PathsOptions {
  surface?: CurvedSurface;
  islands: readonly IslandSpec[];
  plots: ReadonlyMap<string, PlotSpec>;
  links: readonly GraphLink[];
  doorPosition(filePath: string): Vector3 | null;
  roofPosition(filePath: string): Vector3 | null;
  palette: WorldPalette;
}
const MAX_ROUTES = 32;
const MAX_OVERVIEW_LINKS = 600;
export function createPaths(options: PathsOptions): PathsHandle {
  const group = new Group();
  // Navigation grid is not needed to paint graph links or the first frame.
  let router: ReturnType<typeof createMailRouter> | undefined;
  const material = new MeshBasicMaterial({
    color: "#edbd76",
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
  });
  const overviewOpacity = 0.38 * Math.min(1, Math.sqrt(24 / Math.max(1, options.links.length)));
  const overviewMaterial = new LineBasicMaterial({
    color: options.palette.mood === "night" ? "#86b8c7" : "#527d91",
    transparent: true,
    opacity: overviewOpacity,
    depthWrite: false,
  });
  const packetMaterial = new MeshBasicMaterial({ color: "#fff1c5" });
  const packetGeometry = new BoxGeometry(1.4, 0.7, 2.2);
  const packets = new InstancedMesh(packetGeometry, packetMaterial, MAX_ROUTES);
  packets.name = "harbor-mail-packets";
  packets.count = 0;
  packets.frustumCulled = false;
  group.add(packets);
  const roofCeiling = Math.max(
    30,
    ...Array.from(options.plots.keys(), (path) => options.roofPosition(path)?.y ?? 30),
  );
  function arc(pair: TrailPair): QuadraticBezierCurve3 {
    const from = pair.from.clone().add(new Vector3(0, 3, 0));
    const to = pair.to.clone().add(new Vector3(0, 3, 0));
    const control = from.clone().lerp(to, 0.5);
    control.y =
      Math.max(roofCeiling + 28, from.y, to.y) + Math.min(110, from.distanceTo(to) * 0.38);
    return new QuadraticBezierCurve3(from, control, to);
  }
  const overviewPoints: number[] = [];
  const seen = new Set<string>();
  for (const link of options.links) {
    const key = [link.source, link.target].sort().join("\0");
    if (seen.has(key) || seen.size >= MAX_OVERVIEW_LINKS) continue;
    const from = options.roofPosition(link.source),
      to = options.roofPosition(link.target);
    if (!from || !to || link.source === link.target) continue;
    seen.add(key);
    const c = arc({ from, to });
    let previous = c.getPoint(0);
    options.surface?.project(previous, previous);
    for (let i = 1; i <= 24; i++) {
      const next = c.getPoint(i / 24);
      options.surface?.project(next, next);
      overviewPoints.push(...previous.toArray(), ...next.toArray());
      previous = next;
    }
  }
  const overviewGeometry = new BufferGeometry();
  overviewGeometry.setAttribute("position", new Float32BufferAttribute(overviewPoints, 3));
  const overview = new LineSegments(overviewGeometry, overviewMaterial);
  overview.name = "harbor-graph-overview";
  group.add(overview);
  let mesh: Mesh | null = null,
    curves: QuadraticBezierCurve3[] = [],
    lengths: number[] = [];
  let lastFocus = "";
  const matrix = new Matrix4(),
    q = new Quaternion(),
    scale = new Vector3(1, 1, 1),
    forward = new Vector3(0, 0, 1);
  function update(time: number): void {
    if (!curves.length) return;
    curves.forEach((c, i) => {
      const t = ((time * 12) / Math.max(1, lengths[i]) + i * 0.19) % 1;
      const p = c.getPointAt(t),
        d = c.getTangentAt(t);
      q.setFromUnitVectors(forward, d);
      matrix.compose(p, q, scale);
      options.surface?.placeMatrix(matrix);
      packets.setMatrixAt(i, matrix);
    });
    packets.instanceMatrix.needsUpdate = true;
  }
  function setFocusTrails(pairs: readonly TrailPair[]): void {
    const bounded = pairs.slice(0, MAX_ROUTES);
    const key = bounded
      .map(({ from, to }) => `${from.toArray().join(",")}:${to.toArray().join(",")}`)
      .join("|");
    if (key === lastFocus) return;
    lastFocus = key;
    if (mesh) {
      group.remove(mesh);
      mesh.geometry.dispose();
      mesh = null;
    }
    curves = bounded.map(arc);
    lengths = curves.map((c) => c.getLength());
    const geometries = curves.map((c) => new TubeGeometry(c, 40, 0.38, 5, false));
    if (geometries.length) {
      const geometry = mergeGeometries(geometries);
      geometries.forEach((g) => g.dispose());
      options.surface?.bendGeometry(geometry);
      mesh = new Mesh(geometry, material);
      mesh.name = "harbor-mail-routes";
      group.add(mesh);
    }
    overviewMaterial.opacity = curves.length ? overviewOpacity * 0.3 : overviewOpacity;
    packets.count = curves.length;
    update(0);
  }
  return {
    group,
    bridges: new Map(),
    setFocusTrails,
    routeBetween: (from, to) => {
      router ??= createMailRouter(options.plots, options.islands);
      return router([{ from, to }])[0]?.map((p) => p.setY(0)) ?? null;
    },
    update,
    dispose: () => {
      mesh?.geometry.dispose();
      overviewGeometry.dispose();
      overviewMaterial.dispose();
      material.dispose();
      packetGeometry.dispose();
      packetMaterial.dispose();
      packets.dispose();
    },
  };
}
