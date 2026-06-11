// ── Agent World Nature & Village Props ──
//
// Medieval dressing per island: trees, rocks and flowers in the wild parts,
// and around the plaza a stone well, market stalls, banner poles, torches,
// fenced crop fields. Everything sits on the ground — nothing floats. At
// night the torches are the only things that move, with a gentle flicker.

import { Group, Vector3 } from "three";

import { BLOCK, PLAZA_RADIUS, stableNoise, type IslandSpec, type PlotSpec } from "../voxel_layout";
import { glowBatch, solidBatch, type BoxWrite, type VoxelBatch } from "./batch";
import { clusterAccent, type WorldPalette } from "./palette";

/** Places agents can work at, exported so the simulation can route to them. */
export interface WorkSite {
  position: Vector3;
  /** Facing of the prop (stalls); 0 elsewhere. */
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

interface TorchFlame {
  index: number;
  x: number;
  y: number;
  z: number;
  seed: number;
}

const PLOT_CLEARANCE = 2.6 * BLOCK;

interface IslandContext {
  island: IslandSpec;
  plotPositions: Vector3[];
  surfaceY: number;
}

/**
 * Deterministically samples a free spot on the island interior, away from the
 * plaza, the beach, and every building plot. Returns null when crowded.
 */
function findFreeSpot(context: IslandContext, seed: string, clearance: number): Vector3 | null {
  const { island, plotPositions } = context;
  const innerRadius = (island.radiusBlocks - 3.2) * BLOCK;
  const minRadius = (PLAZA_RADIUS + 1.8) * BLOCK;
  if (innerRadius <= minRadius) return null;

  for (let attempt = 0; attempt < 10; attempt++) {
    const angle = stableNoise(`${seed}:a${attempt}`) * Math.PI * 2;
    const radius = minRadius + stableNoise(`${seed}:r${attempt}`) * (innerRadius - minRadius);
    const x = island.center.x + Math.cos(angle) * radius;
    const z = island.center.z + Math.sin(angle) * radius;
    const blocked = plotPositions.some((plot) => Math.hypot(plot.x - x, plot.z - z) < clearance);
    if (!blocked) return new Vector3(x, context.surfaceY, z);
  }
  return null;
}

// ── Wild nature ───────────────────────────────────────────────

function pushRoundTree(writes: BoxWrite[], at: Vector3, seed: string, palette: WorldPalette) {
  const trunkHeight = 4.6 + stableNoise(`${seed}:th`) * 2;
  writes.push({
    x: at.x,
    y: at.y + trunkHeight / 2,
    z: at.z,
    sx: 1.4,
    sy: trunkHeight,
    sz: 1.4,
    color: palette.trunk,
  });
  const canopy = 5.6 + stableNoise(`${seed}:c`) * 2.4;
  writes.push({
    x: at.x,
    y: at.y + trunkHeight + canopy * 0.34,
    z: at.z,
    sx: canopy,
    sy: canopy * 0.9,
    sz: canopy,
    color: palette.leaf,
  });
  writes.push({
    x: at.x + (stableNoise(`${seed}:lx`) * 2 - 1) * canopy * 0.42,
    y: at.y + trunkHeight + canopy * 0.16,
    z: at.z + (stableNoise(`${seed}:lz`) * 2 - 1) * canopy * 0.42,
    sx: canopy * 0.62,
    sy: canopy * 0.55,
    sz: canopy * 0.62,
    color: palette.leafAlt,
  });
}

function pushPineTree(writes: BoxWrite[], at: Vector3, seed: string, palette: WorldPalette) {
  const trunkHeight = 3.4 + stableNoise(`${seed}:th`) * 1.4;
  writes.push({
    x: at.x,
    y: at.y + trunkHeight / 2,
    z: at.z,
    sx: 1.2,
    sy: trunkHeight,
    sz: 1.2,
    color: palette.trunk,
  });
  const tiers = [6.6, 4.8, 3] as const;
  for (const [tier, width] of tiers.entries()) {
    writes.push({
      x: at.x,
      y: at.y + trunkHeight + tier * 2 + 1,
      z: at.z,
      sx: width,
      sy: 2.2,
      sz: width,
      color: palette.pine,
    });
  }
}

function pushBush(writes: BoxWrite[], at: Vector3, seed: string, palette: WorldPalette) {
  const size = 2.2 + stableNoise(`${seed}:s`) * 1.6;
  writes.push({
    x: at.x,
    y: at.y + size * 0.4,
    z: at.z,
    sx: size,
    sy: size * 0.8,
    sz: size,
    color: stableNoise(`${seed}:c`) > 0.5 ? palette.leaf : palette.leafAlt,
  });
}

function pushRock(writes: BoxWrite[], at: Vector3, seed: string, palette: WorldPalette) {
  const size = 1.6 + stableNoise(`${seed}:s`) * 2.2;
  writes.push({
    x: at.x,
    y: at.y + size * 0.3,
    z: at.z,
    sx: size,
    sy: size * 0.8,
    sz: size * (0.8 + stableNoise(`${seed}:d`) * 0.5),
    rotY: stableNoise(`${seed}:r`) * Math.PI,
    color: palette.rock,
  });
}

// ── Village props ─────────────────────────────────────────────

/** Stone well with a little accent roof at the heart of every plaza. */
function pushWell(writes: BoxWrite[], island: IslandSpec, palette: WorldPalette, accent: string) {
  const { x, z } = island.center;
  const y = island.elevation * BLOCK;
  // Stone ring.
  writes.push({ x, y: y + 0.9, z, sx: 4.4, sy: 1.8, sz: 4.4, color: palette.stoneBase });
  writes.push({ x, y: y + 1.9, z, sx: 3, sy: 1.4, sz: 3, color: "#1c2430" });
  // Posts and roof.
  for (const side of [-1, 1]) {
    writes.push({
      x: x + side * 2,
      y: y + 3.4,
      z,
      sx: 0.6,
      sy: 5,
      sz: 0.6,
      color: palette.timber,
    });
  }
  writes.push({ x, y: y + 6.2, z, sx: 5.6, sy: 0.9, sz: 3.4, color: accent });
  writes.push({ x, y: y + 7, z, sx: 3.4, sy: 0.9, sz: 2.4, color: accent });
}

/** Market stall: counter, posts, striped awning in the island accent. */
function pushMarketStall(
  writes: BoxWrite[],
  at: Vector3,
  rotY: number,
  palette: WorldPalette,
  accent: string,
  seed: string,
) {
  const cos = Math.cos(rotY);
  const sin = Math.sin(rotY);
  const place = (
    lx: number,
    ly: number,
    lz: number,
    sx: number,
    sy: number,
    sz: number,
    color: string,
  ) =>
    writes.push({
      x: at.x + lx * cos + lz * sin,
      y: at.y + ly,
      z: at.z - lx * sin + lz * cos,
      sx,
      sy,
      sz,
      rotY,
      color,
    });

  // Counter and goods.
  place(0, 1.4, 0, 6.4, 2.8, 3.2, palette.timber);
  place(0, 3, 0, 5.8, 0.5, 2.8, palette.trim);
  const goods = palette.flowers[Math.floor(stableNoise(`${seed}:goods`) * palette.flowers.length)];
  place(-1.4, 3.7, 0, 1.4, 0.9, 1.4, goods);
  place(1.2, 3.7, 0.4, 1.6, 1.1, 1.6, palette.thatch);
  // Posts.
  for (const side of [-1, 1]) {
    place(side * 2.9, 3.4, -1.2, 0.5, 6.8, 0.5, palette.timber);
    place(side * 2.9, 3.4, 1.2, 0.5, 6.8, 0.5, palette.timber);
  }
  // Awning: one solid canvas slab with accent stripes wrapped around it.
  // Wrapping (slightly taller/deeper than the slab) avoids the coplanar
  // faces that made the old side-by-side stripes shimmer.
  place(0, 7, 0.3, 7.6, 0.56, 4.6, palette.awning);
  for (const stripe of [-2, 0, 2]) {
    place(stripe * 1.5, 7, 0.3, 1.5, 0.82, 4.85, accent);
  }
}

/** Banner pole with the island accent flag. */
function pushBanner(
  writes: BoxWrite[],
  at: Vector3,
  rotY: number,
  accent: string,
  palette: WorldPalette,
) {
  writes.push({
    x: at.x,
    y: at.y + 5.4,
    z: at.z,
    sx: 0.55,
    sy: 10.8,
    sz: 0.55,
    rotY,
    color: palette.timber,
  });
  const cos = Math.cos(rotY);
  const sin = Math.sin(rotY);
  writes.push({
    x: at.x + 1.9 * cos,
    y: at.y + 9.1,
    z: at.z - 1.9 * sin,
    sx: 2.8,
    sy: 3,
    sz: 0.45,
    rotY,
    color: accent,
  });
}

/** Wooden fence run: posts plus a rail, length in blocks along rotY. */
function pushFenceRun(
  writes: BoxWrite[],
  from: Vector3,
  rotY: number,
  lengthUnits: number,
  palette: WorldPalette,
) {
  const cos = Math.cos(rotY);
  const sin = Math.sin(rotY);
  const posts = Math.max(2, Math.round(lengthUnits / 3.2) + 1);
  for (let post = 0; post < posts; post++) {
    const along = (post / (posts - 1)) * lengthUnits;
    writes.push({
      x: from.x + along * sin,
      y: from.y + 1.1,
      z: from.z + along * cos,
      sx: 0.5,
      sy: 2.2,
      sz: 0.5,
      rotY,
      color: palette.fence,
    });
  }
  writes.push({
    x: from.x + (lengthUnits / 2) * sin,
    y: from.y + 1.7,
    z: from.z + (lengthUnits / 2) * cos,
    sx: 0.35,
    sy: 0.45,
    sz: lengthUnits + 0.5,
    rotY,
    color: palette.fence,
  });
}

/** Fenced crop field: tilled soil with crop rows. */
function pushCropField(writes: BoxWrite[], at: Vector3, seed: string, palette: WorldPalette) {
  const rotY = (Math.round(stableNoise(`${seed}:rot`) * 3) * Math.PI) / 2;
  const cos = Math.cos(rotY);
  const sin = Math.sin(rotY);
  const width = 9;
  const depth = 7;
  writes.push({
    x: at.x,
    y: at.y + 0.25,
    z: at.z,
    sx: width,
    sy: 0.5,
    sz: depth,
    rotY,
    color: palette.soil,
  });
  for (let row = -1; row <= 1; row++) {
    for (let col = -2; col <= 2; col++) {
      const grow = 0.7 + stableNoise(`${seed}:${row}:${col}`);
      const lx = col * 1.8;
      const lz = row * 2.1;
      writes.push({
        x: at.x + lx * cos + lz * sin,
        y: at.y + 0.5 + grow / 2,
        z: at.z - lx * sin + lz * cos,
        sx: 0.9,
        sy: grow,
        sz: 0.9,
        rotY,
        color: palette.crop,
      });
    }
  }
  // Fence along two edges of the field (local -Z edge and local -X edge).
  const edgeA = new Vector3(
    at.x + (-width / 2) * cos + (-depth / 2 - 0.7) * sin,
    at.y,
    at.z - (-width / 2) * sin + (-depth / 2 - 0.7) * cos,
  );
  pushFenceRun(writes, edgeA, rotY + Math.PI / 2, width, palette);
  const edgeB = new Vector3(
    at.x + (-width / 2 - 0.7) * cos + (-depth / 2) * sin,
    at.y,
    at.z - (-width / 2 - 0.7) * sin + (-depth / 2) * cos,
  );
  pushFenceRun(writes, edgeB, rotY, depth, palette);
}

export function createNature(
  islands: readonly IslandSpec[],
  plots: ReadonlyMap<string, PlotSpec>,
  palette: WorldPalette,
): NatureHandle {
  const group = new Group();
  const solidWrites: BoxWrite[] = [];
  const flameWrites: BoxWrite[] = [];
  const flames: TorchFlame[] = [];
  const workSites: WorkSites = { fields: [], stalls: [], wells: [], trees: [] };

  const contexts: IslandContext[] = islands.map((island) => ({
    island,
    plotPositions: [...plots.values()]
      .filter((plot) => plot.island.clusterIndex === island.clusterIndex)
      .map((plot) => plot.position),
    surfaceY: island.elevation * BLOCK,
  }));

  for (const context of contexts) {
    const { island } = context;
    const area = Math.PI * island.radiusBlocks ** 2;
    const key = `nat:${island.clusterIndex}`;
    const accent = clusterAccent(island.clusterIndex, palette.mood);

    // ── Plaza centrepiece & market ──
    pushWell(solidWrites, island, palette, accent);
    workSites.wells.push({
      position: new Vector3(island.center.x, context.surfaceY, island.center.z),
      rotY: 0,
      clusterIndex: island.clusterIndex,
    });

    const stallCount = island.radiusBlocks >= 14 ? 2 : 1;
    for (let index = 0; index < stallCount; index++) {
      const angle = stableNoise(`${key}:stall:${index}`) * Math.PI * 2;
      const ring = (PLAZA_RADIUS + 2.6) * BLOCK;
      const at = new Vector3(
        island.center.x + Math.cos(angle) * ring,
        context.surfaceY,
        island.center.z + Math.sin(angle) * ring,
      );
      const blocked = context.plotPositions.some(
        (plot) => Math.hypot(plot.x - at.x, plot.z - at.z) < PLOT_CLEARANCE,
      );
      if (!blocked) {
        const facing = Math.atan2(island.center.x - at.x, island.center.z - at.z);
        pushMarketStall(solidWrites, at, facing, palette, accent, `${key}:stall:${index}`);
        workSites.stalls.push({
          position: at.clone(),
          rotY: facing,
          clusterIndex: island.clusterIndex,
        });
      }
    }

    // ── Banners flanking the plaza ──
    for (let index = 0; index < 2; index++) {
      const angle = stableNoise(`${key}:banner:${index}`) * Math.PI * 2;
      const ring = (PLAZA_RADIUS + 1.2) * BLOCK;
      pushBanner(
        solidWrites,
        new Vector3(
          island.center.x + Math.cos(angle) * ring,
          context.surfaceY,
          island.center.z + Math.sin(angle) * ring,
        ),
        angle,
        accent,
        palette,
      );
    }

    // ── Torches around the plaza ──
    const torchCount = Math.min(5, Math.max(2, Math.round(island.radiusBlocks / 7)));
    for (let index = 0; index < torchCount; index++) {
      const angle = (index / torchCount) * Math.PI * 2 + stableNoise(`${key}:torch:${index}`) * 0.4;
      const ring = (PLAZA_RADIUS + 1.6) * BLOCK;
      const x = island.center.x + Math.cos(angle) * ring;
      const z = island.center.z + Math.sin(angle) * ring;
      const postHeight = 5.6;
      solidWrites.push({
        x,
        y: context.surfaceY + postHeight / 2,
        z,
        sx: 0.65,
        sy: postHeight,
        sz: 0.65,
        color: palette.timber,
      });
      solidWrites.push({
        x,
        y: context.surfaceY + postHeight + 0.4,
        z,
        sx: 1.1,
        sy: 0.8,
        sz: 1.1,
        color: palette.stoneBase,
      });
      const flameY = context.surfaceY + postHeight + 1.4;
      const flameIndex = flameWrites.length;
      flameWrites.push({
        x,
        y: flameY,
        z,
        sx: 1,
        sy: 1.3,
        sz: 1,
        color: palette.torchFlame,
      });
      flames.push({
        index: flameIndex,
        x,
        y: flameY,
        z,
        seed: stableNoise(`${key}:flame:${index}`) * Math.PI * 2,
      });
    }

    // ── Crop fields with fences ──
    const fieldCount = island.radiusBlocks >= 12 ? 2 : 1;
    for (let index = 0; index < fieldCount; index++) {
      const spot = findFreeSpot(context, `${key}:field:${index}`, PLOT_CLEARANCE + BLOCK);
      if (spot) {
        pushCropField(solidWrites, spot, `${key}:field:${index}`, palette);
        workSites.fields.push({
          position: spot.clone(),
          rotY: 0,
          clusterIndex: island.clusterIndex,
        });
      }
    }

    // ── Wild dressing ──
    const treeCount = Math.min(14, Math.max(1, Math.round(area / 55)));
    for (let index = 0; index < treeCount; index++) {
      const seed = `${key}:tree:${index}`;
      const spot = findFreeSpot(context, seed, PLOT_CLEARANCE);
      if (!spot) continue;
      const kind = stableNoise(`${seed}:kind`);
      if (kind < 0.45) pushRoundTree(solidWrites, spot, seed, palette);
      else if (kind < 0.8) pushPineTree(solidWrites, spot, seed, palette);
      else pushBush(solidWrites, spot, seed, palette);
      if (kind < 0.8) {
        // Proper trees (not bushes) are woodcutting sites for rangers.
        workSites.trees.push({
          position: spot.clone(),
          rotY: 0,
          clusterIndex: island.clusterIndex,
        });
      }
    }

    const rockCount = Math.min(5, Math.max(1, Math.round(island.radiusBlocks / 6)));
    for (let index = 0; index < rockCount; index++) {
      const seed = `${key}:rock:${index}`;
      const spot = findFreeSpot(context, seed, PLOT_CLEARANCE * 0.8);
      if (spot) pushRock(solidWrites, spot, seed, palette);
    }

    const flowerCount = Math.min(36, Math.max(4, Math.round(area / 20)));
    for (let index = 0; index < flowerCount; index++) {
      const seed = `${key}:flower:${index}`;
      const spot = findFreeSpot(context, seed, 1.4 * BLOCK);
      if (!spot) continue;
      const color = palette.flowers[Math.floor(stableNoise(`${seed}:c`) * palette.flowers.length)];
      solidWrites.push({
        x: spot.x,
        y: spot.y + 0.45,
        z: spot.z,
        sx: 0.8,
        sy: 0.9,
        sz: 0.8,
        color,
      });
    }
  }

  const solids = solidBatch(solidWrites.length);
  for (const write of solidWrites) solids.add(write);
  solids.commit();
  group.add(solids.mesh);

  // Torch flames: static by day, flickering at night. They stay attached to
  // their torch — flicker is a scale pulse, not movement.
  let flameBatch: VoxelBatch | null = null;
  if (flameWrites.length > 0) {
    flameBatch = glowBatch(flameWrites.length, palette.mood === "night", 0.95);
    for (const write of flameWrites) flameBatch.add(write);
    flameBatch.commit();
    group.add(flameBatch.mesh);
  }

  function update(nowSeconds: number): void {
    if (!flameBatch || palette.mood !== "night") return;
    for (const flame of flames) {
      const flicker =
        1 +
        Math.sin(nowSeconds * 7.3 + flame.seed * 9) * 0.16 +
        Math.sin(nowSeconds * 13.7 + flame.seed * 5) * 0.09;
      flameBatch.set(flame.index, {
        x: flame.x,
        y: flame.y,
        z: flame.z,
        sx: flicker,
        sy: 1.3 * flicker,
        sz: flicker,
        color: palette.torchFlame,
      });
    }
    flameBatch.commit();
  }

  function dispose(): void {
    solids.dispose();
    flameBatch?.dispose();
  }

  return { group, workSites, update, dispose };
}
