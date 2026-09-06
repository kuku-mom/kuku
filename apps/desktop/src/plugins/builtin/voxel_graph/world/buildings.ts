/** Pastel waterfront townhouses, built from reusable real 3D architectural parts. */
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
import { stableNoise, type PlotSpec } from "../voxel_layout";
import type { InteractionIndicatorAnchor } from "./indicators";
import { clusterAccent, type WorldPalette } from "./palette";
import { HarborGeometry } from "./harbor_geometry";
import type { CurvedSurface } from "./curved_surface";
export interface BuildingsHandle {
  group: Group;
  pickMesh: InstancedMesh;
  nodeForInstance(instanceId: number): GraphNode | null;
  indicatorAnchor(filePath: string): InteractionIndicatorAnchor | null;
  doorPosition(filePath: string): Vector3 | null;
  roofPosition(filePath: string): Vector3 | null;
  update(nowSeconds: number): void;
  dispose(): void;
}
export function createBuildings(
  plots: ReadonlyMap<string, PlotSpec>,
  palette: WorldPalette,
  surface?: CurvedSurface,
): BuildingsHandle {
  const kit = new HarborGeometry(surface),
    group = new Group();
  const pickGeometry = new BoxGeometry(1, 1, 1),
    pickMaterial = new MeshBasicMaterial({ colorWrite: false, depthWrite: false });
  const pickMesh = new InstancedMesh(pickGeometry, pickMaterial, Math.max(1, plots.size));
  pickMesh.visible = false; // Explicit raycasts still work; exclude proxies from render passes.
  pickMesh.count = plots.size;
  const nodes: GraphNode[] = [],
    anchors = new Map<
      string,
      { door: Vector3; roof: Vector3; position: Vector3; radius: number }
    >();
  const matrix = new Matrix4(),
    q = new Quaternion();
  for (const plot of plots.values()) {
    const { node, position, rotationY, tier } = plot;
    kit.setAnchor(position);
    const width = 17 + (tier === 2 ? 3 : 0),
      depth = 16;
    const verticalScale = tier === 3 ? 1.85 : 1.5;
    const floors = 2 + tier,
      height = floors * 8.2;
    const accent = clusterAccent(node.clusterIndex, palette.mood);
    const variation = stableNoise(`${node.id}:plaster`);
    const wall =
      tier === 3 ? accent : variation > 0.83 ? "#e1d7c3" : variation < 0.13 ? "#a6b67c" : accent;
    const trim = "#f1e2c5",
      roof = "#365766",
      wood = "#74503a",
      glass = palette.mood === "night" ? "#d3aa6d" : "#30515a";
    const cos = Math.cos(rotationY),
      sin = Math.sin(rotationY);
    function part(
      kind: Parameters<HarborGeometry["add"]>[0],
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
    ) {
      kit.add(
        palette.mood === "night" && color === glass ? "glow" : kind,
        color,
        position.x + (x * cos + z * sin) * 1.18,
        position.y + y * verticalScale,
        position.z + (z * cos - x * sin) * 1.18,
        sx * 1.18,
        sy * verticalScale,
        sz * 1.18,
        rx,
        ry + rotationY,
        rz,
      );
    }
    function box(
      color: string,
      x: number,
      y: number,
      z: number,
      sx: number,
      sy: number,
      sz: number,
    ) {
      part("box", color, x, y, z, sx, sy, sz);
    }
    part("soft", wall, 0, height / 2, 0, width, height, depth);
    box("#a7947c", 0, 0.6, 0, width + 0.8, 1.2, depth + 0.8);
    box(trim, 0, height - 0.3, 0, width + 0.9, 0.75, depth + 0.9);
    box(roof, 0, height + 0.4, 0, width + 2.5, 0.8, depth + 2.5);
    part("roof", roof, 0, height + 0.8, 0, width + 2.7, 6.2, depth + 2.7);
    // Individually laid slate courses catch sunlight at the roof's edge.
    const detail = plots.size < 500;
    if (detail)
      for (const side of [-1, 1])
        for (let row = 0; row < 6; row++) {
          const t = (row + 0.5) / 6;
          const span = (width + 2.7) * (1 - t * 0.5);
          const n = Math.max(2, Math.floor(span / 2.3));
          for (let col = 0; col < n; col++)
            part(
              "box",
              row % 2 ? "#426473" : "#3b5d6b",
              -span / 2 + ((col + 0.5) * span) / n,
              height + 0.9 + t * 6.2,
              ((side * (depth + 2.7)) / 2) * (1 - t),
              span / n - 0.12,
              0.24,
              2,
              side * Math.atan2(6.2, (depth + 2.7) / 2),
            );
        }
    box("#5b7380", 0, height + 7.1, 0, width * 0.52, 0.65, 1.1);
    box(wall, width * 0.28, height + 5, -depth * 0.23, 2.4, 7, 2.5);
    box(trim, width * 0.28, height + 8.5, -depth * 0.23, 3.2, 0.8, 3.2);
    box("#45545a", width * 0.28, height + 8.95, -depth * 0.23, 2.2, 0.18, 2.2);
    // Windows on all four facades, with deep inset, sill and cross mullions.
    for (let face = 0; face < 4; face++) {
      const a = (face * Math.PI) / 2,
        fc = Math.cos(a),
        fs = Math.sin(a),
        fw = face % 2 ? depth : width;
      function facade(
        color: string,
        x: number,
        y: number,
        z: number,
        sx: number,
        sy: number,
        sz: number,
      ) {
        part("box", color, x * fc + z * fs, y, z * fc - x * fs, sx, sy, sz, 0, a);
      }
      for (let floor = 0; floor < floors; floor++)
        for (const col of [-1, 1]) {
          if (floor === 0 && face === 0) continue;
          const x = col * fw * 0.25,
            y = 4.4 + floor * 8.2,
            z = (face % 2 ? width : depth) / 2;
          facade(wood, x, y, z + 0.12, 3.6, 5.1, 0.3);
          facade(trim, x, y, z + 0.36, 3.3, 4.8, 0.3);
          facade(glass, x, y, z + 0.55, 2.6, 4.1, 0.15);
          facade(trim, x, y, z + 0.68, 0.23, 4.3, 0.25);
          facade(trim, x, y + 0.2, z + 0.7, 2.9, 0.22, 0.25);
          facade(trim, x, y - 2.5, z + 0.7, 4.2, 0.55, 1.25);
          if (detail && floor === 1 && col === -1) {
            facade(wood, x, y - 2.2, z + 1, 4, 1, 1.2);
            facade("#637e3b", x, y - 1.7, z + 1.1, 3.8, 0.7, 1.1);
          }
        }
      if (detail)
        for (let row = 0; row < floors * 3; row++)
          for (const side of [-1, 1])
            facade(
              trim,
              side * (fw / 2 - 0.55),
              1.5 + row * 2.65,
              (face % 2 ? width : depth) / 2 + 0.06,
              1.1,
              0.7,
              0.14,
            );
    }
    // Framed door, fanlight, brass handle and an entry step.
    part("arch", trim, 0, 4.4, depth / 2 + 0.4, 5.6, 8.8, 0.8);
    part("arch", wood, 0, 4.1, depth / 2 + 0.9, 4.3, 8, 0.4);
    box(glass, 0, 6.8, depth / 2 + 1.15, 3.1, 1.7, 0.15);
    for (const x of [-1.05, 1.05]) box("#936344", x, 3.3, depth / 2 + 1.18, 1.65, 4.1, 0.18);
    part("sphere", "#dcac58", 1.3, 3.4, depth / 2 + 1.5, 0.48, 0.48, 0.48);
    box("#cbb99b", 0, 0.18, depth / 2 + 1.6, 7, 0.36, 3.2);
    if (tier === 0) {
      for (let i = 0; i < 8; i++)
        part(
          "box",
          i % 2 ? trim : "#c76b56",
          -6.1 + i * 1.75,
          8.1,
          depth / 2 + 2.2,
          1.75,
          0.22,
          4,
          -0.2,
        );
      box(wood, 0, 10.8, depth / 2 + 0.4, 7.5, 2, 0.4);
      box(trim, 0, 10.8, depth / 2 + 0.7, 5.8, 0.25, 0.1);
    }
    if (tier === 3) {
      // Arched, book-lined library wings and a balcony make the archive a landmark.
      for (const side of [-1, 1]) {
        const x = side * 11;
        part("soft", wall, x, 10, 0, 10, 20, 17);
        box(trim, x, 20, 0, 11, 1, 18);
        part("roof", roof, x, 20.5, 0, 12, 4.5, 19);
        part("arch", trim, x, 11, 8.8, 8, 13, 1);
        part("arch", "#473d2e", x, 11, 9.4, 6.7, 11.5, 0.3);
        for (let shelf = 0; shelf < 3; shelf++) {
          box(wood, x, 7 + shelf * 2.7, 9.7, 6.5, 0.35, 0.6);
          for (let book = 0; book < 7; book++)
            box(
              ["#956b4b", "#c9ad78", "#758c85", "#a9815c"][book % 4],
              x - 2.7 + book * 0.85,
              8 + shelf * 2.7,
              9.75,
              0.55,
              1.7,
              0.3,
            );
        }
        box("#b8a587", x, 6.5, 10.8, 11, 0.65, 4);
        for (let rail = 0; rail < 7; rail++)
          box("#344d50", x - 4.5 + rail * 1.5, 8.1, 12.7, 0.18, 3, 0.18);
        box("#344d50", x, 9.6, 12.7, 10, 0.25, 0.25);
      }
      // Archive tower's lantern and steep slate crown.
      box(wall, 0, height + 11, 0, 7.5, 10, 7.5);
      box(trim, 0, height + 15.7, 0, 8.5, 0.7, 8.5);
      box(glass, 0, height + 11, 3.8, 2.5, 5, 0.2);
      box(trim, 0, height + 11, 4, 0.24, 5, 0.2);
      part("cone", roof, 0, height + 20, 0, 10, 8, 10, 0, Math.PI / 4);
      box(wood, 0, height + 26, 0, 0.35, 6, 0.35);
      box("#cf6b4f", 1.5, height + 27, 0, 3, 1.8, 0.15);
    }
    const totalHeight = (height + (tier === 3 ? 29 : 10)) * verticalScale;
    const door = new Vector3(
      position.x + sin * ((depth / 2) * 1.18 + 7),
      position.y,
      position.z + cos * ((depth / 2) * 1.18 + 7),
    );
    anchors.set(node.filePath, {
      door,
      roof: position.clone().add(new Vector3(0, totalHeight, 0)),
      position: position.clone(),
      radius: 17,
    });
    q.setFromAxisAngle(new Vector3(0, 1, 0), rotationY);
    pickMesh.setMatrixAt(
      nodes.length,
      matrix.compose(
        position.clone().add(new Vector3(0, totalHeight / 2, 0)),
        q,
        new Vector3(
          (tier === 3 ? 33 : width + 2) * 1.18,
          totalHeight,
          (tier === 3 ? 26 : depth + 2) * 1.18,
        ),
      ),
    );
    if (surface) {
      pickMesh.getMatrixAt(nodes.length, matrix);
      surface.placeMatrix(matrix, position);
      pickMesh.setMatrixAt(nodes.length, matrix);
    }
    nodes.push(node);
  }
  pickMesh.instanceMatrix.needsUpdate = true;
  pickMesh.computeBoundingSphere();
  group.add(kit.finish(), pickMesh);
  return {
    group,
    pickMesh,
    nodeForInstance: (i) => nodes[i] ?? null,
    indicatorAnchor: (path) => {
      const a = anchors.get(path);
      return a ? { position: a.position.clone(), radius: a.radius } : null;
    },
    doorPosition: (path) => anchors.get(path)?.door.clone() ?? null,
    roofPosition: (path) => anchors.get(path)?.roof.clone() ?? null,
    update: () => {},
    dispose: () => {
      kit.dispose();
      pickGeometry.dispose();
      pickMaterial.dispose();
      pickMesh.dispose();
    },
  };
}
