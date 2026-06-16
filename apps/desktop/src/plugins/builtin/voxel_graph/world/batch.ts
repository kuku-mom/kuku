// ── Instanced Batch ──
//
// Thin wrapper over a single InstancedMesh. Every repeated prop in the world
// (a tree canopy, a roof, an agent limb) is one instance in one of a handful of
// batches, so the whole world renders in a few draw calls regardless of vault
// size. A batch can use any geometry; cel-shaded props use a toon material.

import {
  BoxGeometry,
  Color,
  DynamicDrawUsage,
  Euler,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  Quaternion,
  StaticDrawUsage,
  Vector3,
  type BufferGeometry,
  type Material,
} from "three";

import type { WorldPalette } from "./palette";

import { toonMaterial, type ToonOptions } from "./toon";

const UNIT_CUBE = new BoxGeometry(1, 1, 1);
const HIDDEN_MATRIX = new Matrix4().makeScale(0, 0, 0);

const tmpMatrix = new Matrix4();
const tmpPosition = new Vector3();
const tmpQuaternion = new Quaternion();
const tmpEuler = new Euler();
const tmpScale = new Vector3();
const tmpColor = new Color();

export interface BoxWrite {
  x: number;
  y: number;
  z: number;
  sx: number;
  sy: number;
  sz: number;
  rotX?: number;
  rotY?: number;
  rotZ?: number;
  color: string | number | Color;
}

export class VoxelBatch {
  readonly mesh: InstancedMesh<BufferGeometry, Material>;
  private cursor = 0;
  private readonly capacity: number;
  private readonly ownsGeometry: boolean;

  constructor(
    material: Material,
    capacity: number,
    dynamic = false,
    geometry: BufferGeometry = UNIT_CUBE,
    ownsGeometry = false,
  ) {
    const safeCapacity = Math.max(1, capacity);
    this.capacity = safeCapacity;
    this.ownsGeometry = ownsGeometry;
    this.mesh = new InstancedMesh(geometry, material, safeCapacity);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(dynamic ? DynamicDrawUsage : StaticDrawUsage);
    // Touch instanceColor so the buffer exists before first render.
    this.mesh.setColorAt(0, tmpColor.set("#ffffff"));
  }

  /** Reserves the next instance slot and writes it. Returns the slot index. */
  add(write: BoxWrite): number {
    const index = this.cursor;
    if (index >= this.capacity) return -1;
    this.cursor += 1;
    this.mesh.count = this.cursor;
    this.set(index, write);
    return index;
  }

  /** Reserves `count` consecutive slots (initially hidden). Returns the first index. */
  reserve(count: number): number {
    const start = this.cursor;
    if (start + count > this.capacity) return -1;
    for (let index = start; index < start + count; index++) {
      this.mesh.setMatrixAt(index, HIDDEN_MATRIX);
    }
    this.cursor += count;
    this.mesh.count = this.cursor;
    return start;
  }

  set(index: number, write: BoxWrite): void {
    if (index < 0 || index >= this.capacity) return;
    tmpPosition.set(write.x, write.y, write.z);
    tmpEuler.set(write.rotX ?? 0, write.rotY ?? 0, write.rotZ ?? 0);
    tmpQuaternion.setFromEuler(tmpEuler);
    tmpScale.set(write.sx, write.sy, write.sz);
    tmpMatrix.compose(tmpPosition, tmpQuaternion, tmpScale);
    this.mesh.setMatrixAt(index, tmpMatrix);
    this.mesh.setColorAt(index, tmpColor.set(write.color));
  }

  setColor(index: number, color: string | number | Color): void {
    if (index < 0 || index >= this.capacity) return;
    this.mesh.setColorAt(index, tmpColor.set(color));
  }

  hide(index: number): void {
    if (index < 0 || index >= this.capacity) return;
    this.mesh.setMatrixAt(index, HIDDEN_MATRIX);
  }

  commit(): void {
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.material.dispose();
    if (this.ownsGeometry) this.mesh.geometry.dispose();
    this.mesh.dispose();
  }
}

/** Lit cube batch (used by the focus marker). */
export function solidBatch(capacity: number, dynamic = false): VoxelBatch {
  const material = new MeshBasicMaterial({ color: "#ffffff" });
  return new VoxelBatch(material, capacity, dynamic);
}

/** Unlit cube batch for emissive-looking geometry (pulses, markers). */
export function glowBatch(capacity: number, dynamic = false, opacity = 1): VoxelBatch {
  const material = new MeshBasicMaterial({
    color: "#ffffff",
    transparent: opacity < 1,
    opacity,
  });
  return new VoxelBatch(material, capacity, dynamic);
}

/**
 * Cel-shaded batch over an arbitrary geometry. The batch owns the toon
 * material; pass `ownsGeometry` when the geometry is unique to this batch so it
 * is disposed with the batch.
 */
export function toonBatch(
  palette: WorldPalette,
  geometry: BufferGeometry,
  capacity: number,
  options: ToonOptions & { dynamic?: boolean; ownsGeometry?: boolean } = {},
): VoxelBatch {
  const material = toonMaterial(palette, options);
  return new VoxelBatch(
    material,
    capacity,
    options.dynamic ?? false,
    geometry,
    options.ownsGeometry ?? false,
  );
}
