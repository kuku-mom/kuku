// ── Agent World Buildings ──
//
// Every note gets a procedural medieval building on its plot. Size grows with
// the document: thatched hut → timber-frame cottage → two-storey manor →
// stone watchtower. Cottages are half-timbered (plaster walls with dark
// beams), manors carry the island accent on their tiled roofs, and towers fly
// an accent banner. Windows light up warmly at night. House instances are
// pickable so hovering/clicking a building targets its note.

import { Color, Group, Vector3, type InstancedMesh, type MeshBasicMaterial } from "three";

import type { GraphNode } from "~/plugins/builtin/graph_view/graph_types";

import { stableNoise, type PlotSpec } from "../voxel_layout";
import { glowBatch, solidBatch, type BoxWrite } from "./batch";
import { clusterAccent, type WorldPalette } from "./palette";

export interface BuildingsHandle {
  group: Group;
  /** The solid instanced mesh, used for raycast picking. */
  pickMesh: InstancedMesh;
  nodeForInstance(instanceId: number): GraphNode | null;
  /** Tints all instances of one house; pass null to restore. */
  setTint(filePath: string, tint: string | null): void;
  /** World position just outside the door — agent home / path anchor. */
  doorPosition(filePath: string): Vector3 | null;
  /** World position of the rooftop, for markers and labels. */
  roofPosition(filePath: string): Vector3 | null;
  update(nowSeconds: number): void;
  dispose(): void;
}

interface HouseRecord {
  plot: PlotSpec;
  firstInstance: number;
  instanceCount: number;
  baseColors: string[];
  door: Vector3;
  roof: Vector3;
}

/** Rotates a local offset by the plot rotation and adds the plot center. */
function placed(plot: PlotSpec, lx: number, ly: number, lz: number): Vector3 {
  const cos = Math.cos(plot.rotationY);
  const sin = Math.sin(plot.rotationY);
  return new Vector3(
    plot.position.x + lx * cos + lz * sin,
    plot.position.y + ly,
    plot.position.z - lx * sin + lz * cos,
  );
}

interface HouseBuilder {
  solid: BoxWrite[];
  windows: BoxWrite[];
  plot: PlotSpec;
  wall: string;
  accent: string;
  palette: WorldPalette;
}

function pushBox(
  builder: HouseBuilder,
  target: "solid" | "windows",
  lx: number,
  ly: number,
  lz: number,
  sx: number,
  sy: number,
  sz: number,
  color: string,
): void {
  const at = placed(builder.plot, lx, ly, lz);
  const write: BoxWrite = {
    x: at.x,
    y: at.y,
    z: at.z,
    sx,
    sy,
    sz,
    rotY: builder.plot.rotationY,
    color,
  };
  (target === "solid" ? builder.solid : builder.windows).push(write);
}

/** Stepped voxel roof with a timber ridge: stacked slabs shrinking upward. */
function pushRoof(
  builder: HouseBuilder,
  baseY: number,
  width: number,
  depth: number,
  steps: number,
  color: string,
): number {
  let y = baseY;
  for (let step = 0; step < steps; step++) {
    const shrink = step * 2.6;
    pushBox(
      builder,
      "solid",
      0,
      y + 0.8,
      0,
      Math.max(2.4, width - shrink),
      1.6,
      Math.max(2.4, depth - shrink),
      color,
    );
    y += 1.6;
  }
  // Ridge beam.
  pushBox(
    builder,
    "solid",
    0,
    y + 0.4,
    0,
    Math.max(2.8, width - steps * 2.6 + 1.2),
    0.8,
    1.1,
    builder.palette.timber,
  );
  return y + 0.8;
}

/** Half-timbering: corner posts plus base and top beams around the walls. */
function pushTimberFrame(
  builder: HouseBuilder,
  width: number,
  depth: number,
  baseY: number,
  wallHeight: number,
): void {
  const { timber } = builder.palette;
  // Posts stand proud of the beams by a clear margin so their faces never
  // come close enough to the beam faces to depth-fight.
  for (const cx of [-1, 1]) {
    for (const cz of [-1, 1]) {
      pushBox(
        builder,
        "solid",
        (cx * (width - 0.5)) / 2,
        baseY + wallHeight / 2,
        (cz * (depth - 0.5)) / 2,
        1,
        wallHeight,
        1,
        timber,
      );
    }
  }
  pushBox(builder, "solid", 0, baseY + 0.35, 0, width + 0.3, 0.7, depth + 0.3, timber);
  pushBox(builder, "solid", 0, baseY + wallHeight - 0.35, 0, width + 0.3, 0.7, depth + 0.3, timber);
}

function pushWindowRow(
  builder: HouseBuilder,
  y: number,
  depth: number,
  offsets: readonly number[],
  windowColor: string,
): void {
  for (const lx of offsets) {
    // Timber frame behind the glass.
    pushBox(builder, "solid", lx, y, depth / 2 + 0.08, 2.3, 2.6, 0.4, builder.palette.timber);
    pushBox(builder, "windows", lx, y, depth / 2 + 0.24, 1.7, 2, 0.4, windowColor);
  }
}

function pushDoor(builder: HouseBuilder, depth: number, baseY: number): void {
  const { palette } = builder;
  pushBox(builder, "solid", 0, baseY + 2.3, depth / 2 + 0.1, 3.2, 4.6, 0.4, palette.timber);
  pushBox(builder, "solid", 0, baseY + 2.1, depth / 2 + 0.26, 2.4, 4.2, 0.4, palette.door);
}

/** Stone watchtower for hub notes: crenellated parapet and an accent banner. */
function buildTower(builder: HouseBuilder, windowColor: string): void {
  const { palette, accent } = builder;
  const width = 9;
  const depth = 9;
  const wallHeight = 16;
  const baseY = 1.2;

  pushBox(builder, "solid", 0, 0.6, 0, width + 2, 1.2, depth + 2, palette.stoneBase);
  pushBox(
    builder,
    "solid",
    0,
    baseY + wallHeight / 2,
    0,
    width,
    wallHeight,
    depth,
    palette.stoneBase,
  );
  // Stone banding.
  pushBox(
    builder,
    "solid",
    0,
    baseY + wallHeight * 0.36,
    0,
    width + 0.3,
    0.8,
    depth + 0.3,
    palette.timber,
  );
  pushDoor(builder, depth, baseY);
  pushWindowRow(builder, baseY + 6.4, depth, [-width * 0.22, width * 0.22], windowColor);
  pushWindowRow(builder, baseY + 11.6, depth, [0], windowColor);

  // Parapet platform and crenellations.
  const topY = baseY + wallHeight;
  pushBox(builder, "solid", 0, topY + 0.6, 0, width + 2.4, 1.2, depth + 2.4, palette.stoneBase);
  const merlonRing = (width + 1.6) / 2;
  for (const cx of [-1, 0, 1]) {
    for (const cz of [-1, 0, 1]) {
      if (cx === 0 && cz === 0) continue;
      pushBox(
        builder,
        "solid",
        cx * merlonRing,
        topY + 1.9,
        cz * merlonRing,
        1.5,
        1.4,
        1.5,
        palette.stoneBase,
      );
    }
  }
  // Banner pole with the island accent.
  pushBox(builder, "solid", 0, topY + 3.6, 0, 0.55, 5.4, 0.55, palette.timber);
  pushBox(builder, "solid", 1.6, topY + 5.2, 0, 2.7, 2.2, 0.35, accent);
}

function buildHouse(builder: HouseBuilder): void {
  const { plot, palette } = builder;
  const seed = plot.node.id;
  const windowColor = palette.mood === "night" ? palette.windowNight : palette.windowDay;

  if (plot.tier === 3) {
    buildTower(builder, windowColor);
    return;
  }

  // Footprint per tier: [width, depth, wallHeight, roofSteps]
  const dims: Record<number, [number, number, number, number]> = {
    0: [8, 8, 5.5, 3],
    1: [10, 9, 7, 4],
    2: [12, 10, 11, 4],
  };
  const [width, depth, wallHeight, roofSteps] = dims[plot.tier];
  const baseY = 1.2;

  // Stone foundation.
  pushBox(builder, "solid", 0, 0.6, 0, width + 1.8, 1.2, depth + 1.8, palette.stoneBase);

  // Plaster walls with half-timbering.
  pushBox(builder, "solid", 0, baseY + wallHeight / 2, 0, width, wallHeight, depth, builder.wall);
  pushTimberFrame(builder, width, depth, baseY, wallHeight);

  pushDoor(builder, depth, baseY);

  if (plot.tier === 0) {
    pushWindowRow(builder, baseY + 3, depth, [width * 0.28], windowColor);
  } else if (plot.tier === 1) {
    pushWindowRow(builder, baseY + 3.4, depth, [-width * 0.27, width * 0.27], windowColor);
  } else {
    pushWindowRow(builder, baseY + 3.2, depth, [-width * 0.28, width * 0.28], windowColor);
    // Second storey with its own beam line.
    pushBox(builder, "solid", 0, baseY + 5.9, 0, width + 0.4, 0.7, depth + 0.4, palette.timber);
    pushWindowRow(builder, baseY + 7.8, depth, [-width * 0.28, 0, width * 0.28], windowColor);
  }

  // Roof: thatch for cottages, accent tiles for the manor.
  const roofBase = baseY + wallHeight;
  const roofColor = plot.tier === 2 ? builder.accent : palette.thatch;
  const roofTop = pushRoof(builder, roofBase, width + 2.4, depth + 2.4, roofSteps, roofColor);

  // Stone chimney on bigger homes.
  if (plot.tier >= 1 && stableNoise(`${seed}:chimney`) > 0.4) {
    pushBox(
      builder,
      "solid",
      width * 0.26,
      roofTop + 0.8,
      -depth * 0.18,
      1.7,
      Math.max(2.6, roofTop - roofBase + 2.6),
      1.7,
      palette.stoneBase,
    );
  }
}

export function createBuildings(
  plots: ReadonlyMap<string, PlotSpec>,
  palette: WorldPalette,
): BuildingsHandle {
  const group = new Group();
  const solidWrites: BoxWrite[] = [];
  const windowWrites: BoxWrite[] = [];
  const records = new Map<string, HouseRecord>();

  for (const plot of plots.values()) {
    const wall =
      palette.walls[Math.floor(stableNoise(`${plot.node.id}:wall`) * palette.walls.length)];
    const builder: HouseBuilder = {
      solid: solidWrites,
      windows: windowWrites,
      plot,
      wall,
      accent: clusterAccent(plot.island.clusterIndex, palette.mood),
      palette,
    };

    const firstInstance = solidWrites.length;
    buildHouse(builder);
    const instanceCount = solidWrites.length - firstInstance;

    const depths: Record<number, number> = { 0: 8, 1: 9, 2: 10, 3: 9 };
    const heights: Record<number, number> = { 0: 12, 1: 15, 2: 19, 3: 22 };
    records.set(plot.node.filePath, {
      plot,
      firstInstance,
      instanceCount,
      baseColors: solidWrites
        .slice(firstInstance)
        .map((write) => (typeof write.color === "string" ? write.color : "#ffffff")),
      door: placed(plot, 0, 0, depths[plot.tier] / 2 + 2),
      roof: placed(plot, 0, heights[plot.tier], 0),
    });
  }

  const solids = solidBatch(solidWrites.length);
  for (const write of solidWrites) solids.add(write);
  solids.commit();
  group.add(solids.mesh);

  const windows = glowBatch(windowWrites.length);
  for (const write of windowWrites) windows.add(write);
  windows.commit();
  group.add(windows.mesh);

  // Reverse lookup: instanceId → note. Built once; instances are static.
  const nodeByInstance: (GraphNode | null)[] = Array.from(
    { length: solidWrites.length },
    () => null,
  );
  for (const record of records.values()) {
    for (let index = 0; index < record.instanceCount; index++) {
      nodeByInstance[record.firstInstance + index] = record.plot.node;
    }
  }

  const tintColor = new Color();
  const baseColor = new Color();

  function setTint(filePath: string, tint: string | null): void {
    const record = records.get(filePath);
    if (!record) return;
    for (let index = 0; index < record.instanceCount; index++) {
      baseColor.set(record.baseColors[index]);
      if (tint) baseColor.lerp(tintColor.set(tint), 0.42);
      solids.setColor(record.firstInstance + index, baseColor);
    }
    solids.commit();
  }

  const windowMaterial = windows.mesh.material as MeshBasicMaterial;

  function update(nowSeconds: number): void {
    if (palette.mood !== "night") return;
    // Gentle communal flicker — cheap material-level shimmer.
    const flicker = 0.93 + Math.sin(nowSeconds * 1.8) * 0.04 + Math.sin(nowSeconds * 5.3) * 0.03;
    windowMaterial.color.setScalar(flicker);
  }

  return {
    group,
    pickMesh: solids.mesh,
    nodeForInstance: (instanceId) => nodeByInstance[instanceId] ?? null,
    setTint,
    doorPosition: (filePath) => records.get(filePath)?.door.clone() ?? null,
    roofPosition: (filePath) => records.get(filePath)?.roof.clone() ?? null,
    update,
    dispose: () => {
      solids.dispose();
      windows.dispose();
    },
  };
}
