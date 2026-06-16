// ── Agent World Nature ──
//
// Detailed cel-shaded greenery. Trees are built from many overlapping leaf
// clumps over tapered trunks with branch stubs, in several species (broadleaf,
// tall canopy trees, layered conifers, bare dead snags). The ground is dressed
// with grass tufts, boulders and flowers, plus a few working props (fields,
// stalls, wells) that double as destinations for the agents' work routines.

import {
  BoxGeometry,
  CircleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  Quaternion,
  Vector3,
  type BufferGeometry,
} from "three";

import type { WorldPalette } from "./palette";

import {
  BLOCK,
  clamp,
  islandSurfaceY,
  PLAZA_RADIUS,
  stableNoise,
  type IslandSpec,
  type PlotSpec,
} from "../voxel_layout";
import { toonBatch, type BoxWrite, type VoxelBatch } from "./batch";
import { noOutline } from "./toon";

const GOLDEN_ANGLE = 2.399963229728653;

export interface WorkSite {
  position: Vector3;
  rotY: number;
  clusterIndex: number;
}

export interface WorkSites {
  fields: WorkSite[];
  stalls: WorkSite[];
  wells: WorkSite[];
  trees: WorkSite[];
}

export interface NatureHandle {
  group: Group;
  workSites: WorkSites;
  update(nowSeconds: number): void;
  dispose(): void;
}

interface NatureOptions {
  densityMultiplier?: number;
}

function noise(key: string): number {
  return stableNoise(key);
}

/** Lumpy unit blob (displaced icosphere) so each leaf clump has a hand-drawn edge. */
function buildBlobGeometry(detail: number): BufferGeometry {
  const geometry = new IcosahedronGeometry(1, detail);
  const position = geometry.attributes.position;
  const v = new Vector3();
  for (let i = 0; i < position.count; i++) {
    v.fromBufferAttribute(position, i);
    const key = `blob:${Math.round(v.x * 7)}:${Math.round(v.y * 7)}:${Math.round(v.z * 7)}`;
    v.multiplyScalar(0.78 + stableNoise(key) * 0.44);
    position.setXYZ(i, v.x, v.y, v.z);
  }
  geometry.computeVertexNormals();
  return geometry;
}

export function createNature(
  islands: readonly IslandSpec[],
  plots: ReadonlyMap<string, PlotSpec>,
  palette: WorldPalette,
  options: NatureOptions = {},
): NatureHandle {
  const group = new Group();
  const workSites: WorkSites = { fields: [], stalls: [], wells: [], trees: [] };
  const density = clamp(options.densityMultiplier ?? 1, 0.2, 2);
  const densityCount = (count: number, min = 0): number =>
    Math.max(min, Math.round(count * density));

  const trunkWrites: BoxWrite[] = [];
  const clumpWrites: BoxWrite[] = [];
  const pineWrites: BoxWrite[] = [];
  const grassWrites: BoxWrite[] = [];
  const rockWrites: BoxWrite[] = [];
  const flowerWrites: BoxWrite[] = [];
  const propWrites: BoxWrite[] = [];
  const plazaWrites: BoxWrite[] = [];
  // Flat ground-shadow discs under trees/bushes, grounding them like the houses.
  const treeShadows: { x: number; y: number; z: number; r: number }[] = [];

  const plotsByIsland = new Map<number, Vector3[]>();
  for (const plot of plots.values()) {
    const existing = plotsByIsland.get(plot.island.clusterIndex) ?? [];
    existing.push(plot.position);
    plotsByIsland.set(plot.island.clusterIndex, existing);
  }

  function farFromPlots(x: number, z: number, list: Vector3[], min: number): boolean {
    for (const p of list) {
      if (Math.hypot(p.x - x, p.z - z) < min) return false;
    }
    return true;
  }

  function clumpColor(vert: number, seed: string): string {
    const jitter = noise(`cc:${seed}`) * 0.18;
    const t = clamp(vert + jitter - 0.09, 0, 1);
    if (t > 0.62) return palette.canopyLight;
    if (t > 0.3) return palette.canopy;
    return palette.canopyDark;
  }

  // A dome of overlapping leaf clumps — the detail that makes a tree read lush.
  function addCanopy(
    cx: number,
    cy: number,
    cz: number,
    radius: number,
    count: number,
    seed: string,
  ): void {
    for (let i = 0; i < count; i++) {
      const a = noise(`ca:${seed}:${i}`) * Math.PI * 2 + i * GOLDEN_ANGLE;
      const rr = Math.sqrt(noise(`cr:${seed}:${i}`)) * radius * 0.82;
      const h = (noise(`ch:${seed}:${i}`) * 1.2 - 0.18) * radius;
      const cR = radius * (0.4 + noise(`cs:${seed}:${i}`) * 0.32);
      const vert = clamp(0.5 + h / (radius * 1.1), 0, 1);
      clumpWrites.push({
        x: cx + Math.cos(a) * rr,
        y: cy + h,
        z: cz + Math.sin(a) * rr,
        sx: cR * (0.92 + noise(`cw:${seed}:${i}`) * 0.3),
        sy: cR * (0.86 + noise(`cv:${seed}:${i}`) * 0.3),
        sz: cR * (0.92 + noise(`cu:${seed}:${i}`) * 0.3),
        rotX: noise(`crx:${seed}:${i}`) * Math.PI,
        rotY: noise(`cry:${seed}:${i}`) * Math.PI * 2,
        rotZ: noise(`crz:${seed}:${i}`) * Math.PI,
        color: clumpColor(vert, `${seed}:${i}`),
      });
    }
  }

  function addTrunk(
    x: number,
    z: number,
    surfaceY: number,
    height: number,
    baseR: number,
    lean: number,
    seed: string,
  ): { topX: number; topZ: number; topY: number } {
    const leanA = noise(`la:${seed}`) * Math.PI * 2;
    const dx = Math.cos(leanA) * lean;
    const dz = Math.sin(leanA) * lean;
    trunkWrites.push({
      x: x + dx * 0.5,
      y: surfaceY + height / 2,
      z: z + dz * 0.5,
      sx: baseR,
      sy: height,
      sz: baseR,
      rotX: dz * 0.06,
      rotZ: -dx * 0.06,
      color: noise(`tk:${seed}`) > 0.5 ? palette.trunk : palette.trunkDark,
    });
    return { topX: x + dx, topZ: z + dz, topY: surfaceY + height };
  }

  function addBranches(
    topX: number,
    topY: number,
    topZ: number,
    count: number,
    length: number,
    seed: string,
  ): void {
    for (let i = 0; i < count; i++) {
      const a = noise(`ba:${seed}:${i}`) * Math.PI * 2;
      const len = length * (0.6 + noise(`bl:${seed}:${i}`) * 0.6);
      trunkWrites.push({
        x: topX + Math.cos(a) * len * 0.4,
        y: topY - len * 0.1 + noise(`by:${seed}:${i}`) * len * 0.3,
        z: topZ + Math.sin(a) * len * 0.4,
        sx: 0.34 * BLOCK,
        sy: len,
        sz: 0.34 * BLOCK,
        rotZ: Math.cos(a) * 0.9,
        rotX: Math.sin(a) * 0.9,
        color: palette.trunkDark,
      });
    }
  }

  function addBroadleaf(x: number, z: number, surfaceY: number, seed: string): void {
    const height = (2.8 + noise(`th:${seed}`) * 2.4) * BLOCK;
    const baseR = (0.42 + noise(`tr:${seed}`) * 0.2) * BLOCK;
    const top = addTrunk(x, z, surfaceY, height, baseR, 0.6 * BLOCK * noise(`tl:${seed}`), seed);
    addBranches(
      top.topX,
      top.topY,
      top.topZ,
      2 + Math.floor(noise(`bn:${seed}`) * 2),
      2.2 * BLOCK,
      seed,
    );
    const radius = (1.9 + noise(`cR:${seed}`) * 1.1) * BLOCK;
    addCanopy(
      top.topX,
      top.topY + radius * 0.15,
      top.topZ,
      radius,
      13 + Math.floor(noise(`cn:${seed}`) * 9),
      seed,
    );
  }

  function addTallTree(x: number, z: number, surfaceY: number, seed: string): void {
    const height = (4.6 + noise(`th:${seed}`) * 3.2) * BLOCK;
    const baseR = (0.36 + noise(`tr:${seed}`) * 0.16) * BLOCK;
    const top = addTrunk(x, z, surfaceY, height, baseR, 0.4 * BLOCK * noise(`tl:${seed}`), seed);
    addBranches(top.topX, top.topY, top.topZ, 3, 2.8 * BLOCK, seed);
    const radius = (1.6 + Number(noise(`cR:${seed}`))) * BLOCK;
    addCanopy(
      top.topX,
      top.topY + radius * 0.1,
      top.topZ,
      radius,
      9 + Math.floor(noise(`cn:${seed}`) * 7),
      seed,
    );
  }

  function addPine(x: number, z: number, surfaceY: number, seed: string): void {
    const trunkH = (1 + noise(`pth:${seed}`) * 0.8) * BLOCK;
    addTrunk(x, z, surfaceY, trunkH, 0.4 * BLOCK, 0, seed);
    const tiers = 6 + Math.floor(noise(`pt:${seed}`) * 3);
    const totalH = (4 + noise(`ph:${seed}`) * 2.6) * BLOCK;
    const baseR = (1.4 + noise(`pr:${seed}`) * 0.7) * BLOCK;
    for (let i = 0; i < tiers; i++) {
      const f = i / tiers;
      const r = baseR * (1 - f * 0.82) + 0.2;
      const h = (totalH / tiers) * 1.7;
      pineWrites.push({
        x,
        y: surfaceY + trunkH + f * totalH * 0.84 + h * 0.35,
        z,
        sx: r * (0.9 + noise(`pw:${seed}:${i}`) * 0.2),
        sy: h,
        sz: r * (0.9 + noise(`pv:${seed}:${i}`) * 0.2),
        rotY: noise(`pry:${seed}:${i}`) * Math.PI,
        color: noise(`pc:${seed}:${i}`) > 0.5 ? palette.pine : palette.canopyDark,
      });
    }
  }

  function addSnag(x: number, z: number, surfaceY: number, seed: string): void {
    const height = (3.5 + noise(`sh:${seed}`) * 3) * BLOCK;
    const top = addTrunk(
      x,
      z,
      surfaceY,
      height,
      0.4 * BLOCK,
      0.9 * BLOCK * noise(`sl:${seed}`),
      seed,
    );
    addBranches(
      top.topX,
      top.topY * 0.9,
      top.topZ,
      2 + Math.floor(noise(`sb:${seed}`) * 2),
      2.4 * BLOCK,
      seed,
    );
  }

  function addBush(x: number, z: number, surfaceY: number, seed: string): void {
    const radius = (1.1 + noise(`br:${seed}`) * 0.8) * BLOCK;
    addCanopy(x, surfaceY + radius * 0.3, z, radius, 4 + Math.floor(noise(`bn:${seed}`) * 4), seed);
  }

  function addRock(x: number, z: number, surfaceY: number, seed: string): void {
    const big = noise(`rb:${seed}`) > 0.78;
    const r = (big ? 2.2 + noise(`rr:${seed}`) * 1.8 : 0.8 + noise(`rr:${seed}`) * 0.9) * BLOCK;
    rockWrites.push({
      x,
      y: surfaceY + r * 0.3,
      z,
      sx: r,
      sy: r * (0.55 + noise(`rh:${seed}`) * 0.4),
      sz: r * (0.8 + noise(`rz:${seed}`) * 0.5),
      rotX: noise(`rx:${seed}`) * 0.5,
      rotY: noise(`ry:${seed}`) * Math.PI,
      rotZ: noise(`rzz:${seed}`) * 0.5,
      color: noise(`rc:${seed}`) > 0.5 ? palette.rock : palette.rockDark,
    });
  }

  function addGrassTuft(x: number, z: number, surfaceY: number, seed: string): void {
    const h = (0.6 + noise(`gh:${seed}`) * 0.9) * BLOCK;
    const w = (0.4 + noise(`gw:${seed}`) * 0.4) * BLOCK;
    const roll = noise(`gc:${seed}`);
    const color =
      roll > 0.6 ? palette.grassLight : roll > 0.25 ? palette.canopy : palette.grassDark;
    grassWrites.push({
      x,
      y: surfaceY + h / 2,
      z,
      sx: w,
      sy: h,
      sz: w,
      rotY: noise(`gr:${seed}`) * Math.PI,
      color,
    });
  }

  function addFlower(x: number, z: number, surfaceY: number, seed: string): void {
    flowerWrites.push({
      x,
      y: surfaceY + 1.1,
      z,
      sx: 1.05,
      sy: 1.9,
      sz: 1.05,
      color: palette.flowers[Math.floor(noise(`fc:${seed}`) * palette.flowers.length)],
    });
  }

  /** A small flower bed — several mixed-colour blooms clustered together. */
  function addFlowerCluster(cx: number, cz: number, surfaceY: number, seed: string): void {
    const count = 5 + Math.floor(noise(`${seed}:n`) * 6);
    for (let i = 0; i < count; i++) {
      const a = noise(`${seed}:a${i}`) * Math.PI * 2;
      const rr = Math.sqrt(noise(`${seed}:r${i}`)) * 1.4 * BLOCK;
      addFlower(cx + Math.cos(a) * rr, cz + Math.sin(a) * rr, surfaceY, `${seed}:f${i}`);
    }
  }

  function addField(x: number, z: number, surfaceY: number, clusterIndex: number): void {
    const size = 3.4 * BLOCK;
    propWrites.push({
      x,
      y: surfaceY + 0.25,
      z,
      sx: size,
      sy: 0.5,
      sz: size,
      color: palette.fieldSoil,
    });
    for (let r = 0; r < 4; r++) {
      propWrites.push({
        x,
        y: surfaceY + 0.8,
        z: z - size / 2 + ((r + 0.5) / 4) * size,
        sx: size * 0.86,
        sy: 0.5,
        sz: size / 9,
        color: palette.crop,
      });
    }
    workSites.fields.push({ position: new Vector3(x, surfaceY, z), rotY: 0, clusterIndex });
  }

  function addStall(
    x: number,
    z: number,
    surfaceY: number,
    rotY: number,
    clusterIndex: number,
    accent: string,
  ): void {
    // A compact little market stall: four corner posts, a flat counter, and a
    // small peaked awning that stays well within its own footprint (no overhang
    // that clips neighbours). Kept small so it sits inside the plaza cleanly.
    const w = 2 * BLOCK;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        propWrites.push({
          x: x + sx * w * 0.42,
          y: surfaceY + 1.5 * BLOCK,
          z: z + sz * w * 0.42,
          sx: 0.26 * BLOCK,
          sy: 3 * BLOCK,
          sz: 0.26 * BLOCK,
          color: palette.beam,
        });
      }
    }
    // Counter top at hip height.
    propWrites.push({
      x,
      y: surfaceY + 1.3 * BLOCK,
      z,
      sx: w * 0.94,
      sy: 0.34 * BLOCK,
      sz: w * 0.94,
      rotY,
      color: palette.wallLight,
    });
    // Awning roof clears head height; slightly narrower than the counter so
    // nothing overhangs the footprint.
    propWrites.push({
      x,
      y: surfaceY + 3 * BLOCK,
      z,
      sx: w * 0.92,
      sy: 0.36 * BLOCK,
      sz: w * 0.92,
      rotY,
      color: accent,
    });
    workSites.stalls.push({ position: new Vector3(x, surfaceY, z), rotY, clusterIndex });
  }

  function addWell(x: number, z: number, surfaceY: number, clusterIndex: number): void {
    // Sized to the villagers (~8.6u tall): a waist-high stone ring, two posts,
    // and a peaked roof that clears head height (so it reads as a well, not a hat).
    trunkWrites.push({
      x,
      y: surfaceY + 1.8,
      z,
      sx: 3.4,
      sy: 3.6,
      sz: 3.4,
      color: palette.foundation,
    });
    for (const side of [-1, 1]) {
      trunkWrites.push({
        x: x + side * 2.6,
        y: surfaceY + 6.4,
        z,
        sx: 0.55,
        sy: 12.8,
        sz: 0.55,
        color: palette.beam,
      });
    }
    // Ridge beam joining the post tops, then the peaked roof above it.
    trunkWrites.push({
      x,
      y: surfaceY + 12.4,
      z,
      sx: 5.6,
      sy: 0.5,
      sz: 0.5,
      color: palette.beam,
    });
    pineWrites.push({
      x,
      y: surfaceY + 13.4,
      z,
      sx: 4.8,
      sy: 2.8,
      sz: 4.8,
      rotY: Math.PI / 4,
      color: palette.roof,
    });
    workSites.wells.push({ position: new Vector3(x, surfaceY, z), rotY: 0, clusterIndex });
  }

  // A farm field — either a tilled dry crop field or a flooded rice paddy. Crop
  // rows cover most of the plot so it reads as a solid coloured tile (patchwork)
  // from above, framed by a hedgerow (dry field) or low mud bund (paddy).
  const FARM_CROPS = ["#d8c466", "#b9cf6a", palette.crop, palette.grassLight];
  function addFarmPatch(cx: number, cz: number, surfaceY: number, seed: string): void {
    const w = (6 + noise(`${seed}:w`) * 5) * BLOCK;
    const d = (6 + noise(`${seed}:d`) * 5) * BLOCK;
    const rot = noise(`${seed}:rot`) * Math.PI;
    const paddy = noise(`${seed}:paddy`) > 0.55;
    propWrites.push({
      x: cx,
      y: surfaceY + 0.22,
      z: cz,
      sx: w,
      sy: 0.5,
      sz: d,
      rotY: rot,
      color: paddy ? "#7fae9f" : palette.fieldSoil,
    });
    const dax = Math.sin(rot);
    const daz = Math.cos(rot);
    const fallow = !paddy && noise(`${seed}:c`) < 0.18;
    if (!fallow) {
      const cropColor = paddy
        ? "#9ec85f"
        : FARM_CROPS[Math.floor(noise(`${seed}:cc`) * FARM_CROPS.length)];
      const rows = 5 + Math.floor(noise(`${seed}:n`) * 6);
      for (let r = 0; r < rows; r++) {
        const off = d * ((r + 0.5) / rows - 0.5);
        propWrites.push({
          x: cx + dax * off,
          y: surfaceY + (paddy ? 0.5 : 0.62),
          z: cz + daz * off,
          sx: w * 0.94,
          sy: 0.5,
          sz: (d / rows) * (paddy ? 0.5 : 0.82),
          rotY: rot,
          color: cropColor,
        });
      }
    }
    // Border: a green hedgerow round a dry field, or a low tan mud bund round a
    // paddy. Either way it reads as tended, hand-divided farmland from above.
    if (paddy || noise(`${seed}:hedge`) > 0.25) {
      const wax = Math.cos(rot);
      const waz = -Math.sin(rot);
      const hh = paddy ? 0.8 : 1.5;
      const hy = surfaceY + hh * 0.5;
      const hColor = paddy ? "#b6a06b" : palette.canopyDark;
      for (const s of [-1, 1]) {
        propWrites.push({
          x: cx + dax * (s * (d / 2)),
          y: hy,
          z: cz + daz * (s * (d / 2)),
          sx: w + 1.4,
          sy: hh,
          sz: 0.9,
          rotY: rot,
          color: hColor,
        });
        propWrites.push({
          x: cx + wax * (s * (w / 2)),
          y: hy,
          z: cz + waz * (s * (w / 2)),
          sx: 0.9,
          sy: hh,
          sz: d + 1.4,
          rotY: rot,
          color: hColor,
        });
      }
    }
    // A lone scarecrow keeping watch over a dry field now and then.
    if (!paddy && !fallow && noise(`${seed}:crow`) > 0.7) {
      addScarecrow(cx, cz, surfaceY, `${seed}:sc`);
    }
  }

  // A straw haystack — a fat round mound, iconic farm dressing.
  function addHaystack(x: number, z: number, surfaceY: number, seed: string): void {
    const r = (1.2 + noise(`${seed}:r`) * 0.8) * BLOCK;
    trunkWrites.push({ x, y: surfaceY + r * 0.45, z, sx: r, sy: r * 0.9, sz: r, color: "#d7b357" });
    pineWrites.push({
      x,
      y: surfaceY + r * 1.1,
      z,
      sx: r * 1.15,
      sy: r * 0.9,
      sz: r * 1.15,
      color: "#cfa848",
    });
    treeShadows.push({ x, y: surfaceY, z, r: r * 1.4 });
  }

  // A simple scarecrow: a post, crossed arms, and a straw head.
  function addScarecrow(x: number, z: number, surfaceY: number, seed: string): void {
    const rot = noise(`${seed}:r`) * Math.PI;
    propWrites.push({
      x,
      y: surfaceY + 2.2,
      z,
      sx: 0.4,
      sy: 4.4,
      sz: 0.4,
      color: palette.trunkDark,
    });
    propWrites.push({
      x,
      y: surfaceY + 3.3,
      z,
      sx: 4.2,
      sy: 0.35,
      sz: 0.35,
      rotY: rot,
      color: palette.trunkDark,
    });
    propWrites.push({ x, y: surfaceY + 4.6, z, sx: 1.1, sy: 1.1, sz: 1.1, color: "#d7b357" });
  }

  // A small wild grove — a handful of clustered trees with ground shadows.
  function addGrove(cx: number, cz: number, surfaceY: number, seed: string): void {
    const n = 2 + Math.floor(noise(`${seed}:n`) * 4);
    for (let i = 0; i < n; i++) {
      const a = noise(`${seed}:a${i}`) * Math.PI * 2;
      const rr = Math.sqrt(noise(`${seed}:r${i}`)) * 3.6 * BLOCK;
      const x = cx + Math.cos(a) * rr;
      const z = cz + Math.sin(a) * rr;
      const s = `${seed}:t${i}`;
      if (noise(`${seed}:k${i}`) > 0.5) {
        addBroadleaf(x, z, surfaceY, s);
        treeShadows.push({ x, y: surfaceY, z, r: 7 });
      } else {
        addPine(x, z, surfaceY, s);
        treeShadows.push({ x, y: surfaceY, z, r: 5.5 });
      }
    }
  }

  for (const island of islands) {
    const surfaceY = islandSurfaceY(island);
    const cx = island.center.x;
    const cz = island.center.z;
    const Rg = island.radiusBlocks * BLOCK;
    const list = plotsByIsland.get(island.clusterIndex) ?? [];
    const spin = noise(`spin:${island.name}`) * Math.PI * 2;
    const accent = palette.flowers[island.clusterIndex % palette.flowers.length];

    // Round stone plaza at the island's heart — the village square that the
    // radiating dirt paths flow into, with a slightly raised rim disc beneath.
    plazaWrites.push({
      x: cx,
      y: surfaceY + 0.18,
      z: cz,
      sx: (PLAZA_RADIUS + 0.9) * BLOCK,
      sy: 0.5,
      sz: (PLAZA_RADIUS + 0.9) * BLOCK,
      color: palette.plaza,
    });

    addWell(cx, cz, surfaceY, island.clusterIndex);
    // Stall sits just inside the plaza edge, opposite the well — close to the
    // square's center so its footprint never reaches the surrounding houses.
    const stallA = spin + 1.2;
    addStall(
      cx + Math.cos(stallA) * (PLAZA_RADIUS - 0.4) * BLOCK,
      cz + Math.sin(stallA) * (PLAZA_RADIUS - 0.4) * BLOCK,
      surfaceY,
      stallA,
      island.clusterIndex,
      accent,
    );

    // ── Trees & boulders ──
    const treeCandidates = densityCount(
      Math.round(clamp(island.radiusBlocks * island.radiusBlocks * 0.025, 4, 16)),
      1,
    );
    let fieldCount = 0;
    for (let i = 0; i < treeCandidates * 2; i++) {
      const rr = Math.sqrt(i / (treeCandidates * 2)) * Rg * 0.97;
      // Keep canopies clear of the plaza so no tree overhangs the village square.
      if (rr < (PLAZA_RADIUS + 4) * BLOCK) continue;
      const ang = i * GOLDEN_ANGLE + spin;
      const x = cx + Math.cos(ang) * rr;
      const z = cz + Math.sin(ang) * rr;
      if (!farFromPlots(x, z, list, 2.8 * BLOCK)) continue;
      const seed = `t:${island.clusterIndex}:${i}`;
      const edge = rr / (Rg * 0.97);
      const roll = noise(`kind:${seed}`);
      if (roll < 0.34 + edge * 0.16) {
        addBroadleaf(x, z, surfaceY, seed);
        treeShadows.push({ x, y: surfaceY, z, r: 7.5 });
        workSites.trees.push({
          position: new Vector3(x, surfaceY, z),
          rotY: 0,
          clusterIndex: island.clusterIndex,
        });
      } else if (roll < 0.56) {
        addTallTree(x, z, surfaceY, seed);
        treeShadows.push({ x, y: surfaceY, z, r: 6 });
        workSites.trees.push({
          position: new Vector3(x, surfaceY, z),
          rotY: 0,
          clusterIndex: island.clusterIndex,
        });
      } else if (roll < 0.72) {
        addPine(x, z, surfaceY, seed);
        treeShadows.push({ x, y: surfaceY, z, r: 5.5 });
        workSites.trees.push({
          position: new Vector3(x, surfaceY, z),
          rotY: 0,
          clusterIndex: island.clusterIndex,
        });
      } else if (roll < 0.79) {
        addSnag(x, z, surfaceY, seed);
        treeShadows.push({ x, y: surfaceY, z, r: 3 });
      } else if (roll < 0.88) {
        addBush(x, z, surfaceY, seed);
        treeShadows.push({ x, y: surfaceY, z, r: 3.5 });
      } else if (roll < 0.97) {
        addRock(x, z, surfaceY, seed);
      } else if (fieldCount < 2) {
        addField(x, z, surfaceY, island.clusterIndex);
        fieldCount += 1;
      }
    }

    // ── Flower beds: clustered blooms scattered across the grass ──
    const beds = densityCount(Math.round(clamp(island.radiusBlocks * 0.4, 3, 10)), 1);
    const bedMin = (PLAZA_RADIUS + 4) * BLOCK;
    const bedMax = (island.radiusBlocks - 5) * BLOCK;
    if (bedMax > bedMin) {
      for (let i = 0; i < beds; i++) {
        const rr =
          bedMin + Math.sqrt(noise(`bedr:${island.clusterIndex}:${i}`)) * (bedMax - bedMin);
        const ang = noise(`beda:${island.clusterIndex}:${i}`) * Math.PI * 2 + spin;
        const x = cx + Math.cos(ang) * rr;
        const z = cz + Math.sin(ang) * rr;
        if (!farFromPlots(x, z, list, 2.4 * BLOCK)) continue;
        addFlowerCluster(x, z, surfaceY, `bed:${island.clusterIndex}:${i}`);
      }
    }

    // ── Village farmland: a ring of fields the hamlet works, just outside the
    // houses, so each village reads as a real farming settlement. ──
    const farmCount = densityCount(Math.round(clamp(island.radiusBlocks * 0.7, 4, 14)), 1);
    const farmMin = (PLAZA_RADIUS + 5) * BLOCK;
    const farmMax = (island.radiusBlocks - 4) * BLOCK;
    if (farmMax > farmMin) {
      for (let i = 0; i < farmCount; i++) {
        const rr =
          farmMin + Math.sqrt(noise(`farmr:${island.clusterIndex}:${i}`)) * (farmMax - farmMin);
        const ang = noise(`farma:${island.clusterIndex}:${i}`) * Math.PI * 2 + spin;
        const x = cx + Math.cos(ang) * rr;
        const z = cz + Math.sin(ang) * rr;
        if (!farFromPlots(x, z, list, 5.5 * BLOCK)) continue;
        addFarmPatch(x, z, surfaceY, `vfarm:${island.clusterIndex}:${i}`);
        if (noise(`vhay:${island.clusterIndex}:${i}`) > 0.7) {
          addHaystack(x + 6, z + 4, surfaceY, `vhay2:${island.clusterIndex}:${i}`);
        }
      }
    }

    // ── Dense ground detail: grass tufts + flower specks ──
    const tufts = densityCount(
      Math.round(clamp(island.radiusBlocks * island.radiusBlocks * 1.1, 80, 760)),
    );
    for (let i = 0; i < tufts; i++) {
      const rr = Math.sqrt(noise(`gt:${island.clusterIndex}:${i}`)) * Rg * 0.94;
      if (rr < (PLAZA_RADIUS + 1.6) * BLOCK) continue;
      const ang = noise(`ga:${island.clusterIndex}:${i}`) * Math.PI * 2;
      const x = cx + Math.cos(ang) * rr;
      const z = cz + Math.sin(ang) * rr;
      const seed = `g:${island.clusterIndex}:${i}`;
      if (noise(`gf:${seed}`) > 0.94) addFlower(x, z, surfaceY, seed);
      else addGrassTuft(x, z, surfaceY, seed);
    }
  }

  // ── Open countryside between the villages: patchwork fields + wild groves ──
  // This is what makes the zoomed-out land read as a lived-in countryside rather
  // than empty lawn. Scattered across the whole landmass, kept clear of villages.
  if (islands.length > 0) {
    const groundY = islandSurfaceY(islands[0]);
    const landR = islands.reduce(
      (m, i) => Math.max(m, i.center.length() + i.radiusBlocks * BLOCK),
      0,
    );
    function nearVillage(x: number, z: number, pad: number): boolean {
      for (const i of islands) {
        if (Math.hypot(x - i.center.x, z - i.center.z) < i.radiusBlocks * BLOCK + pad) return true;
      }
      return false;
    }
    // Farmland dominates the open land (it's countryside, not parkland): mostly
    // fields, some groves, the odd haystack or wildflower patch.
    const features = densityCount(Math.round(clamp((landR / BLOCK) * 1.3, 24, 170)));
    for (let i = 0; i < features; i++) {
      const rr = Math.sqrt(noise(`cs:r:${i}`)) * landR * 0.98;
      const ang = noise(`cs:a:${i}`) * Math.PI * 2;
      const x = Math.cos(ang) * rr;
      const z = Math.sin(ang) * rr;
      if (nearVillage(x, z, 3 * BLOCK)) continue;
      const roll = noise(`cs:k:${i}`);
      if (roll < 0.68) addFarmPatch(x, z, groundY, `fp:${i}`);
      else if (roll < 0.86) addGrove(x, z, groundY, `gv:${i}`);
      else if (roll < 0.93) addHaystack(x, z, groundY, `hs:${i}`);
      else {
        addRock(x, z, groundY, `cr:${i}`);
        addFlowerCluster(x, z, groundY, `cf:${i}`);
      }
    }

    // Roadside trees: a tidy avenue of trees lining each main road out from the
    // central village to its neighbours.
    for (const isl of islands) {
      const len = Math.hypot(isl.center.x, isl.center.z);
      if (len < BLOCK) continue; // the central village
      const ux = isl.center.x / len;
      const uz = isl.center.z / len;
      const px = -uz;
      const pz = ux;
      const segStart = 9 * BLOCK;
      const segEnd = len - isl.radiusBlocks * BLOCK - 2 * BLOCK;
      const count = densityCount(Math.floor((segEnd - segStart) / (11 * BLOCK)));
      for (let k = 0; k < count; k++) {
        const tt = segStart + ((k + 0.5) * (segEnd - segStart)) / Math.max(1, count);
        for (const s of [-1, 1]) {
          const tx = ux * tt + px * s * 5.8;
          const tz = uz * tt + pz * s * 5.8;
          if (nearVillage(tx, tz, 1.2 * BLOCK)) continue;
          addBroadleaf(tx, tz, groundY, `rt:${isl.clusterIndex}:${k}:${s}`);
          treeShadows.push({ x: tx, y: groundY, z: tz, r: 7 });
        }
      }
    }

    // Forest belt: denser woods ringing the edge of the land so the countryside
    // is framed by trees instead of fading to a bare grassy rim.
    const beltCount = densityCount(Math.round(clamp((landR / BLOCK) * 1.05, 20, 150)));
    for (let i = 0; i < beltCount; i++) {
      const rr = (0.84 + noise(`fb:r:${i}`) * 0.14) * landR;
      const ang = noise(`fb:a:${i}`) * Math.PI * 2;
      const x = Math.cos(ang) * rr;
      const z = Math.sin(ang) * rr;
      if (nearVillage(x, z, 1.5 * BLOCK)) continue;
      if (noise(`fb:k:${i}`) > 0.45) {
        addPine(x, z, groundY, `fbp:${i}`);
        treeShadows.push({ x, y: groundY, z, r: 5.5 });
      } else {
        addBroadleaf(x, z, groundY, `fbb:${i}`);
        treeShadows.push({ x, y: groundY, z, r: 7 });
      }
    }
  }

  // ── Build batches ──
  const owned: BufferGeometry[] = [];
  const batches: VoxelBatch[] = [];

  function build(writes: BoxWrite[], geometry: BufferGeometry, opts?: { outline?: boolean }): void {
    if (writes.length === 0) {
      geometry.dispose();
      return;
    }
    owned.push(geometry);
    const batch = toonBatch(palette, geometry, writes.length, { outline: opts?.outline });
    for (const write of writes) batch.add(write);
    batch.commit();
    batches.push(batch);
    group.add(batch.mesh);
  }

  build(plazaWrites, new CylinderGeometry(1, 1, 1, 24), { outline: false });
  build(trunkWrites, new CylinderGeometry(0.4, 0.62, 1, 6));
  build(clumpWrites, buildBlobGeometry(1));
  build(pineWrites, new ConeGeometry(1, 1, 7));
  build(rockWrites, buildBlobGeometry(0));
  build(propWrites, new BoxGeometry(1, 1, 1));
  build(grassWrites, new ConeGeometry(0.7, 1, 4), { outline: false });
  build(flowerWrites, new ConeGeometry(0.8, 1, 5), { outline: false });

  // ── Tree ground shadows (one instanced batch of flat discs) ──
  let shadowMesh: InstancedMesh | null = null;
  let shadowGeometry: CircleGeometry | null = null;
  let shadowMaterial: MeshBasicMaterial | null = null;
  if (treeShadows.length > 0) {
    shadowGeometry = new CircleGeometry(0.5, 18);
    shadowMaterial = new MeshBasicMaterial({
      color: new Color("#1d2417"),
      transparent: true,
      opacity: 0.14,
      depthWrite: false,
      side: DoubleSide,
    });
    noOutline(shadowMaterial);
    shadowMesh = new InstancedMesh(shadowGeometry, shadowMaterial, treeShadows.length);
    shadowMesh.frustumCulled = false;
    shadowMesh.renderOrder = -1;
    const m = new Matrix4();
    const pos = new Vector3();
    const quat = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2);
    const scl = new Vector3();
    for (let i = 0; i < treeShadows.length; i++) {
      const s = treeShadows[i];
      pos.set(s.x, s.y + 0.14, s.z);
      scl.set(s.r * 2, s.r * 2, 1);
      m.compose(pos, quat, scl);
      shadowMesh.setMatrixAt(i, m);
    }
    shadowMesh.instanceMatrix.needsUpdate = true;
    group.add(shadowMesh);
  }

  function update(_nowSeconds: number): void {
    // Foliage is static; agents and clouds carry the motion.
  }

  function dispose(): void {
    for (const batch of batches) batch.dispose();
    for (const geometry of owned) geometry.dispose();
    shadowMesh?.dispose();
    shadowGeometry?.dispose();
    shadowMaterial?.dispose();
  }

  return { group, workSites, update, dispose };
}
