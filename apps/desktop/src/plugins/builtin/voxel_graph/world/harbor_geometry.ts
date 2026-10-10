/** Shared, instanced architectural parts. A vault adds instances, not draw calls. */
import {
  BoxGeometry,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  Euler,
  Vector3,
  Float32BufferAttribute,
  Shape,
  ExtrudeGeometry,
} from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";

import type { CurvedSurface } from "./curved_surface";

export type Part = "box" | "glow" | "soft" | "pot" | "sphere" | "cone" | "roof" | "arch" | "hull";
interface Piece {
  kind: Part;
  color: string;
  p: number[];
  s: number[];
  r: number[];
  anchor?: Vector3;
}
export class HarborGeometry {
  readonly group = new Group();
  private surface?: CurvedSurface;
  private anchor?: Vector3;
  constructor(surface?: CurvedSurface) {
    this.surface = surface;
  }
  setAnchor(anchor?: Vector3): void {
    this.anchor = anchor?.clone();
  }
  private pieces: Piece[] = [];
  private geometries: BufferGeometry[] = [];
  private meshes: InstancedMesh[] = [];
  private glowMaterial = new MeshStandardMaterial({
    roughness: 0.7,
    emissive: "#eac27f",
    emissiveIntensity: 0.55,
  });
  private material = new MeshStandardMaterial({ roughness: 0.82, metalness: 0.02 });
  add(
    kind: Part,
    color: string,
    x: number,
    y: number,
    z: number,
    sx: number,
    sy: number,
    sz: number,
    rx = 0,
    ry = 0,
    rz = 0,
  ): void {
    this.pieces.push({
      kind,
      color,
      p: [x, y, z],
      s: [sx, sy, sz],
      r: [rx, ry, rz],
      anchor: this.anchor,
    });
  }
  box(
    color: string,
    x: number,
    y: number,
    z: number,
    sx: number,
    sy: number,
    sz: number,
    ry = 0,
  ): void {
    this.add("box", color, x, y, z, sx, sy, sz, 0, ry);
  }
  finish(): Group {
    for (const kind of new Set(this.pieces.map((p) => p.kind))) {
      const entries = this.pieces.filter((p) => p.kind === kind);
      const geometry =
        kind === "soft"
          ? new RoundedBoxGeometry(1, 1, 1, 1, 0.045)
          : kind === "pot"
            ? new CylinderGeometry(0.5, 0.36, 1, 12)
            : kind === "sphere"
              ? new IcosahedronGeometry(0.5, 2)
              : kind === "cone"
                ? new ConeGeometry(0.71, 1, 4)
                : kind === "arch"
                  ? arch()
                  : kind === "hull"
                    ? hull()
                    : kind === "roof"
                      ? hipRoof()
                      : new BoxGeometry(1, 1, 1);
      const mesh = new InstancedMesh(
        geometry,
        kind === "glow" ? this.glowMaterial : this.material,
        entries.length,
      );
      const matrix = new Matrix4(),
        q = new Quaternion(),
        p = new Vector3(),
        s = new Vector3(),
        e = new Euler();
      entries.forEach((entry, i) => {
        p.fromArray(entry.p);
        s.fromArray(entry.s);
        e.set(entry.r[0], entry.r[1], entry.r[2]);
        q.setFromEuler(e);
        matrix.compose(p, q, s);
        this.surface?.placeMatrix(matrix, entry.anchor);
        mesh.setMatrixAt(i, matrix);
        mesh.setColorAt(i, new Color(entry.color));
      });
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      this.geometries.push(geometry);
      this.meshes.push(mesh);
      this.group.add(mesh);
    }
    this.pieces = [];
    return this.group;
  }
  dispose(): void {
    for (const m of this.meshes) m.dispose();
    for (const g of this.geometries) g.dispose();
    this.material.dispose();
    this.glowMaterial.dispose();
    this.group.clear();
  }
}
function hipRoof(): BufferGeometry {
  const a = [-0.5, 0, -0.5],
    b = [0.5, 0, -0.5],
    c = [0.5, 0, 0.5],
    d = [-0.5, 0, 0.5],
    e = [-0.25, 1, 0],
    f = [0.25, 1, 0];
  const g = new BufferGeometry();
  g.setAttribute(
    "position",
    new Float32BufferAttribute(
      [
        ...a,
        ...e,
        ...b,
        ...b,
        ...e,
        ...f,
        ...b,
        ...f,
        ...c,
        ...c,
        ...f,
        ...d,
        ...d,
        ...f,
        ...e,
        ...d,
        ...e,
        ...a,
      ],
      3,
    ),
  );
  g.computeVertexNormals();
  return g;
}

function arch(): BufferGeometry {
  const shape = new Shape();
  shape.moveTo(-0.5, -0.5);
  shape.lineTo(0.5, -0.5);
  shape.lineTo(0.5, 0.15);
  shape.bezierCurveTo(0.5, 0.62, -0.5, 0.62, -0.5, 0.15);
  shape.closePath();
  const g = new ExtrudeGeometry(shape, { depth: 1, bevelEnabled: false, curveSegments: 12 });
  g.translate(0, 0, -0.5);
  return g;
}
function hull(): BufferGeometry {
  const shape = new Shape();
  shape.moveTo(0, 0.5);
  shape.bezierCurveTo(0.48, 0.4, 0.5, 0.2, 0.5, -0.2);
  shape.quadraticCurveTo(0.5, -0.5, 0.32, -0.5);
  shape.lineTo(-0.32, -0.5);
  shape.quadraticCurveTo(-0.5, -0.5, -0.5, -0.2);
  shape.bezierCurveTo(-0.5, 0.2, -0.48, 0.4, 0, 0.5);
  const g = new ExtrudeGeometry(shape, {
    depth: 1,
    bevelEnabled: true,
    bevelThickness: 0.08,
    bevelSize: 0.08,
    bevelSegments: 2,
    steps: 1,
    curveSegments: 8,
  });
  g.rotateX(-Math.PI / 2);
  g.translate(0, -0.5, 0);
  return g;
}
