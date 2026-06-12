// ── Agent World Terrain ──
//
// One voxel island per vault folder, floating in a shared ocean. Islands are
// flat-topped so agents can roam them, with a sand beach ring, a stone plaza
// at the center, and a dirt skirt that drops below the waterline.

import { Group, Mesh, BoxGeometry, MeshLambertMaterial, type ColorRepresentation } from "three";

import { BLOCK, PLAZA_RADIUS, stableNoise, type IslandSpec } from "../voxel_layout";
import { glowBatch, solidBatch, type BoxWrite, type VoxelBatch } from "./batch";
import type { WorldPalette } from "./palette";

export interface TerrainHandle {
  group: Group;
  update(nowSeconds: number): void;
  dispose(): void;
}

const BEACH_WIDTH = 2.1;
const SKIRT_DEPTH_BLOCKS = 2.5;
/** Water surface sits slightly below the beach step. */
export const WATER_LEVEL = -0.35 * BLOCK;

function cellColor(
  island: IslandSpec,
  bx: number,
  bz: number,
  dist: number,
  palette: WorldPalette,
): ColorRepresentation {
  if (dist <= PLAZA_RADIUS + 0.4) {
    return (bx + bz) % 2 === 0 ? palette.plaza : palette.plazaAlt;
  }
  if (dist > island.radiusBlocks - BEACH_WIDTH) return palette.sand;
  return stableNoise(`grass:${island.clusterIndex}:${bx}:${bz}`) > 0.5
    ? palette.grass
    : palette.grassAlt;
}

function buildIslandWrites(island: IslandSpec, palette: WorldPalette): BoxWrite[] {
  const writes: BoxWrite[] = [];
  const radius = island.radiusBlocks;
  const topY = island.elevation * BLOCK;

  for (let bx = -radius; bx <= radius; bx++) {
    for (let bz = -radius; bz <= radius; bz++) {
      const dist = Math.hypot(bx, bz);
      if (dist > radius) continue;

      const isBeach = dist > radius - BEACH_WIDTH;
      const cellTop = isBeach ? topY - BLOCK : topY;
      const x = island.center.x + bx * BLOCK;
      const z = island.center.z + bz * BLOCK;

      // Top surface cube.
      writes.push({
        x,
        y: cellTop - BLOCK / 2,
        z,
        sx: BLOCK,
        sy: BLOCK,
        sz: BLOCK,
        color: cellColor(island, bx, bz, dist, palette),
      });

      // Dirt skirt: edge cells extend down past the waterline so the island
      // reads as a solid landmass from every camera angle.
      const isEdge = dist > radius - 1.4;
      if (isEdge) {
        const skirtTop = cellTop - BLOCK;
        const skirtBottom = WATER_LEVEL - SKIRT_DEPTH_BLOCKS * BLOCK;
        const skirtHeight = skirtTop - skirtBottom;
        if (skirtHeight > 0) {
          writes.push({
            x,
            y: skirtBottom + skirtHeight / 2,
            z,
            sx: BLOCK,
            sy: skirtHeight,
            sz: BLOCK,
            color: palette.dirt,
          });
        }
      }
    }
  }

  return writes;
}

function buildFoam(islands: readonly IslandSpec[], palette: WorldPalette): VoxelBatch {
  let capacity = 0;
  for (const island of islands) {
    capacity += Math.ceil((Math.PI * 2 * island.radiusBlocks) / 1.5);
  }
  const foam = glowBatch(capacity, false, palette.mood === "day" ? 0.5 : 0.28);

  for (const island of islands) {
    const dots = Math.ceil((Math.PI * 2 * island.radiusBlocks) / 1.5);
    for (let index = 0; index < dots; index++) {
      const angle =
        (index / dots) * Math.PI * 2 + stableNoise(`foam:${island.clusterIndex}:${index}`) * 0.3;
      const ring =
        (island.radiusBlocks + 0.7 + stableNoise(`foam-r:${island.clusterIndex}:${index}`) * 0.9) *
        BLOCK;
      const size = 1.6 + stableNoise(`foam-s:${island.clusterIndex}:${index}`) * 2.2;
      foam.add({
        x: island.center.x + Math.cos(angle) * ring,
        y: WATER_LEVEL + 0.3,
        z: island.center.z + Math.sin(angle) * ring,
        sx: size,
        sy: 0.5,
        sz: size,
        color: palette.mood === "day" ? "#ffffff" : "#9fc4d8",
      });
    }
  }
  foam.commit();
  return foam;
}

export function createTerrain(
  islands: readonly IslandSpec[],
  palette: WorldPalette,
  worldRadiusUnits: number,
): TerrainHandle {
  const group = new Group();

  // Islands
  const writes: BoxWrite[] = [];
  for (const island of islands) {
    writes.push(...buildIslandWrites(island, palette));
  }
  const ground = solidBatch(writes.length);
  for (const write of writes) ground.add(write);
  ground.commit();
  group.add(ground.mesh);

  // Ocean: one large slab spanning the visible world.
  const oceanSize = Math.max(worldRadiusUnits * 4.4, 2_400);
  const oceanGeometry = new BoxGeometry(oceanSize, BLOCK, oceanSize);
  const oceanMaterial = new MeshLambertMaterial({
    color: palette.water,
    emissive: palette.waterEmissive,
    emissiveIntensity: 0.1,
    transparent: true,
    opacity: 0.96,
  });
  const ocean = new Mesh(oceanGeometry, oceanMaterial);
  ocean.position.y = WATER_LEVEL - BLOCK / 2;
  group.add(ocean);

  // Deep water tint below, hides the void under the world edge.
  const deepGeometry = new BoxGeometry(oceanSize, BLOCK * 4, oceanSize);
  const deepMaterial = new MeshLambertMaterial({ color: palette.waterDeep });
  const deep = new Mesh(deepGeometry, deepMaterial);
  deep.position.y = WATER_LEVEL - BLOCK * 3;
  group.add(deep);

  // Shore foam
  const foam = buildFoam(islands, palette);
  group.add(foam.mesh);

  function update(nowSeconds: number): void {
    oceanMaterial.emissiveIntensity = 0.1 + Math.sin(nowSeconds * 1.3) * 0.045;
  }

  function dispose(): void {
    ground.dispose();
    foam.dispose();
    oceanGeometry.dispose();
    oceanMaterial.dispose();
    deepGeometry.dispose();
    deepMaterial.dispose();
  }

  return { group, update, dispose };
}
