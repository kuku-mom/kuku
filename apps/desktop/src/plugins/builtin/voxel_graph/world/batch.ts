// ── Voxel Batch ──
//
// Thin wrapper over a single InstancedMesh of unit cubes. Every static or
// dynamic box in the world is one instance in one of a handful of batches, so
// the whole world renders in a few draw calls regardless of vault size.

import {
  BoxGeometry,
  Color,
  DynamicDrawUsage,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  MeshLambertMaterial,
  Quaternion,
  StaticDrawUsage,
  Vector3,
  type Material,
} from "three";

const UNIT_CUBE = new BoxGeometry(1, 1, 1);
const HIDDEN_MATRIX = new Matrix4().makeScale(0, 0, 0);

const tmpMatrix = new Matrix4();
const tmpPosition = new Vector3();
const tmpQuaternion = new Quaternion();
const tmpScale = new Vector3();
const tmpAxis = new Vector3(0, 1, 0);
const tmpColor = new Color();

export interface BoxWrite {
  x: number;
  y: number;
  z: number;
  sx: number;
  sy: number;
  sz: number;
  rotY?: number;
  color: string | number | Color;
}

export class VoxelBatch {
  readonly mesh: InstancedMesh<BoxGeometry, Material>;
  private cursor = 0;
  private readonly capacity: number;

  constructor(material: Material, capacity: number, dynamic = false) {
    const safeCapacity = Math.max(1, capacity);
    this.capacity = safeCapacity;
    this.mesh = new InstancedMesh(UNIT_CUBE, material, safeCapacity);
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
    tmpQuaternion.setFromAxisAngle(tmpAxis, write.rotY ?? 0);
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
    // Unit cube geometry is shared module-wide; only the material is owned.
    this.mesh.material.dispose();
    this.mesh.dispose();
  }
}

/** Lit batch for solid world geometry. */
export function solidBatch(capacity: number, dynamic = false): VoxelBatch {
  const material = new MeshLambertMaterial({ color: "#ffffff" });
  return new VoxelBatch(material, capacity, dynamic);
}

/** Unlit batch for emissive-looking geometry (windows, lamps, pulses, stars). */
export function glowBatch(capacity: number, dynamic = false, opacity = 1): VoxelBatch {
  const material = new MeshBasicMaterial({
    color: "#ffffff",
    transparent: opacity < 1,
    opacity,
  });
  return new VoxelBatch(material, capacity, dynamic);
}
