import { BLOCK, type IslandSpec } from "../voxel_layout";
import type { Vector3 } from "three";
/** One source of truth for masonry edges and the simulation's safe ground. */
export function harborBounds(islands: readonly IslandSpec[]) {
  const minX = islands.length
    ? Math.min(...islands.map((i) => i.center.x - i.radiusBlocks * BLOCK)) - 8
    : -48;
  const maxX = islands.length
    ? Math.max(...islands.map((i) => i.center.x + i.radiusBlocks * BLOCK)) + 8
    : 48;
  const minZ = islands.length
    ? Math.min(...islands.map((i) => i.center.z - i.radiusBlocks * BLOCK)) - 8
    : -48;
  const maxZ = islands.length
    ? Math.max(...islands.map((i) => i.center.z + i.radiusBlocks * BLOCK)) + 8
    : 48;
  const width = maxX - minX,
    depth = maxZ - minZ;
  const tile = Math.max(7, Math.sqrt((width * depth) / 18000));
  const nx = Math.ceil(width / tile),
    nz = Math.ceil(depth / tile);
  return { minX, maxX, minZ, maxZ, nx, nz, cutX: (width / nx) * 2, cutZ: (depth / nz) * 2 };
}
export type HarborBounds = ReturnType<typeof harborBounds>;
export function constrainToHarbor(point: Vector3, b: HarborBounds, margin = 4): void {
  point.x = Math.max(b.minX + margin, Math.min(b.maxX - margin, point.x));
  point.z = Math.max(b.minZ + margin, Math.min(b.maxZ - margin, point.z));
  if (
    (point.x < b.minX + b.cutX + margin || point.x > b.maxX - b.cutX - margin) &&
    (point.z < b.minZ + b.cutZ + margin || point.z > b.maxZ - b.cutZ - margin)
  ) {
    point.x = Math.max(b.minX + b.cutX + margin, Math.min(b.maxX - b.cutX - margin, point.x));
  }
}
