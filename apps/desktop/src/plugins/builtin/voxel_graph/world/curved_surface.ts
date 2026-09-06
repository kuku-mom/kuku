/** Spherical render coordinates over a stable, flat navigation chart. */
import { BufferGeometry, Matrix4, Quaternion, Vector3 } from "three";

const UP = new Vector3(0, 1, 0);
export class CurvedSurface {
  readonly radius: number;
  readonly center: Vector3;
  private readonly p = new Vector3();
  private readonly scale = new Vector3();
  private readonly base = new Vector3();
  private readonly ground = new Vector3();
  private readonly normal = new Vector3();
  private readonly q = new Quaternion();
  private readonly tilt = new Quaternion();
  constructor(worldRadius: number) {
    this.radius = Math.max(560, worldRadius * 5.5);
    this.center = new Vector3(0, -this.radius, 0);
  }

  /** Chart distance is arc length; altitude is measured along the radial up vector. */
  project(point: Vector3, out = new Vector3()): Vector3 {
    const distance = Math.hypot(point.x, point.z),
      angle = distance / this.radius;
    const altitude = this.radius + point.y;
    const radial = distance > 1e-9 ? (Math.sin(angle) * altitude) / distance : 0;
    return out.set(point.x * radial, Math.cos(angle) * altitude - this.radius, point.z * radial);
  }

  unproject(point: Vector3, out = new Vector3()): Vector3 {
    const y = point.y + this.radius,
      horizontal = Math.hypot(point.x, point.z);
    const distance = Math.atan2(horizontal, y) * this.radius;
    const scale = horizontal > 1e-9 ? distance / horizontal : 0;
    return out.set(point.x * scale, Math.hypot(horizontal, y) - this.radius, point.z * scale);
  }

  normalAt(point: Vector3, out = new Vector3()): Vector3 {
    const distance = Math.hypot(point.x, point.z),
      angle = distance / this.radius;
    const scale = distance > 1e-9 ? Math.sin(angle) / distance : 0;
    return out.set(point.x * scale, Math.cos(angle), point.z * scale);
  }

  orientationAt(point: Vector3, out = new Quaternion()): Quaternion {
    return out.setFromUnitVectors(UP, this.normalAt(point, this.normal));
  }

  /** Buildings stay rigid on their own tangent plane; roofs/windows share one frame. */
  placeMatrix(matrix: Matrix4, anchor?: Vector3): Matrix4 {
    const { p, q, scale, tilt } = this;
    matrix.decompose(p, q, scale);
    const base = anchor ?? this.base.set(p.x, 0, p.z);
    this.orientationAt(base, tilt);
    p.sub(base).applyQuaternion(tilt).add(this.project(base, this.ground));
    q.premultiply(tilt);
    return matrix.compose(p, q, scale);
  }

  /** Tessellated terrain and route ribbons follow the sphere continuously. */
  bendGeometry(geometry: BufferGeometry): BufferGeometry {
    const positions = geometry.getAttribute("position"),
      p = new Vector3();
    for (let i = 0; i < positions.count; i++) {
      p.fromBufferAttribute(positions, i);
      this.project(p, p);
      positions.setXYZ(i, p.x, p.y, p.z);
    }
    positions.needsUpdate = true;
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
  }
}
