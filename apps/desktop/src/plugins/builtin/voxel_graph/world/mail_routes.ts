/** Bounded breadth-first routing on walkable stone. One search serves every linked note. */
import { Vector3 } from "three";
import type { PlotSpec, IslandSpec } from "../voxel_layout";
import { harborBounds } from "./harbor_bounds";
export interface MailEndpoints {
  from: Vector3;
  to: Vector3;
}
export function createMailRouter(
  plots: ReadonlyMap<string, PlotSpec>,
  islands: readonly IslandSpec[],
) {
  const b = harborBounds(islands),
    width = b.maxX - b.minX,
    depth = b.maxZ - b.minZ;
  const step = Math.max(4, Math.sqrt((width * depth) / 45000)),
    nx = Math.ceil(width / step) + 1,
    nz = Math.ceil(depth / step) + 1;
  const blocked = new Uint8Array(nx * nz);
  const at = (i: number) =>
    new Vector3(b.minX + (i % nx) * step, 0.55, b.minZ + Math.floor(i / nx) * step);
  for (let i = 0; i < blocked.length; i++) {
    const p = at(i);
    const outer = p.x < b.minX + 3 || p.x > b.maxX - 3 || p.z < b.minZ + 3 || p.z > b.maxZ - 3;
    const corner =
      (p.x < b.minX + b.cutX + 3 || p.x > b.maxX - b.cutX - 3) &&
      (p.z < b.minZ + b.cutZ + 3 || p.z > b.maxZ - b.cutZ - 3);
    if (outer || corner) blocked[i] = 1;
  }
  for (const p of plots.values()) {
    const halfX = p.tier === 3 ? 21 : 12,
      halfZ = p.tier === 3 ? 16 : 11;
    const x0 = Math.max(0, Math.floor((p.position.x - halfX - b.minX) / step)),
      x1 = Math.min(nx - 1, Math.ceil((p.position.x + halfX - b.minX) / step));
    const z0 = Math.max(0, Math.floor((p.position.z - halfZ - b.minZ) / step)),
      z1 = Math.min(nz - 1, Math.ceil((p.position.z + halfZ - b.minZ) / step));
    for (let z = z0; z <= z1; z++)
      for (let x = x0; x <= x1; x++) {
        const px = b.minX + x * step,
          pz = b.minZ + z * step;
        if (Math.abs(px - p.position.x) <= halfX && Math.abs(pz - p.position.z) <= halfZ)
          blocked[z * nx + x] = 1;
      }
  }
  function nearest(p: Vector3): number {
    const cx = Math.round((p.x - b.minX) / step),
      cz = Math.round((p.z - b.minZ) / step);
    let best = -1,
      distance = Infinity;
    for (let dz = -3; dz <= 3; dz++)
      for (let dx = -3; dx <= 3; dx++) {
        const x = cx + dx,
          z = cz + dz,
          i = z * nx + x;
        if (x < 0 || z < 0 || x >= nx || z >= nz || blocked[i]) continue;
        const candidate = at(i),
          d = candidate.distanceToSquared(p) + (candidate.z < p.z ? step * step : 0);
        if (d < distance) {
          distance = d;
          best = i;
        }
      }
    return best;
  }
  // Reuse a bounded set of search trees when residents leave the same doors.
  const trees = new Map<number, Int32Array>();
  const queue = new Int32Array(blocked.length);
  return (pairs: readonly MailEndpoints[]): Vector3[][] => {
    if (!pairs.length) return [];
    const source = nearest(pairs[0].from);
    if (source < 0) return [];
    let parents = trees.get(source);
    if (!parents) {
      parents = new Int32Array(blocked.length).fill(-1);
      let head = 0,
        tail = 1;
      queue[0] = source;
      parents[source] = source;
      while (head < tail) {
        const i = queue[head++],
          x = i % nx,
          z = Math.floor(i / nx);
        for (let direction = 0; direction < 4; direction++) {
          const next =
            direction === 0
              ? x > 0
                ? i - 1
                : -1
              : direction === 1
                ? x < nx - 1
                  ? i + 1
                  : -1
                : direction === 2
                  ? z > 0
                    ? i - nx
                    : -1
                  : z < nz - 1
                    ? i + nx
                    : -1;
          if (next < 0 || blocked[next] || parents[next] !== -1) continue;
          parents[next] = i;
          queue[tail++] = next;
        }
      }
      if (trees.size >= 8) trees.delete(trees.keys().next().value!);
      trees.set(source, parents);
    }
    const routes: Vector3[][] = [];
    for (const pair of pairs) {
      // Focus routes share one origin; refuse unrelated pairs instead of misrouting.
      if (nearest(pair.from) !== source) continue;
      let i = nearest(pair.to);
      if (i < 0 || parents[i] === -1) continue;
      const path: Vector3[] = [];
      while (i !== source) {
        path.push(at(i));
        i = parents[i];
      }
      path.push(at(source));
      path.reverse();
      const compact: Vector3[] = [pair.from.clone().setY(0.55)];
      for (let j = 0; j < path.length; j++) {
        if (
          j === 0 ||
          j === path.length - 1 ||
          path[j].x - path[j - 1].x !== path[j + 1].x - path[j].x ||
          path[j].z - path[j - 1].z !== path[j + 1].z - path[j].z
        )
          compact.push(path[j]);
      }
      compact.push(pair.to.clone().setY(0.55));
      routes.push(compact.filter((p, j) => j === 0 || p.distanceToSquared(compact[j - 1]) > 0.001));
    }
    return routes;
  };
}
