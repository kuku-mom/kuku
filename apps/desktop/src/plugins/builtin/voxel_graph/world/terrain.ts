// ── Agent World Terrain ──
//
// ONE continuous, perfectly flat grassy countryside (top at y=0) ringed by a
// stylised ocean — folders are villages laid out on this single landmass, so
// every house and agent sits on the same level ground (nothing to fall through,
// no slopes, no gaps to bridge). Painterly green blend, rounded sandy shore, and
// earthy cliffs tapering below the waterline. Smooth geometry, cel-shaded.

import {
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshToonMaterial,
  RingGeometry,
  Vector3,
} from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

import type { WorldPalette } from "./palette";

import {
  BLOCK,
  clamp,
  ISLAND_ELEVATION,
  islandSurfaceY,
  stableNoise,
  type IslandSpec,
} from "../voxel_layout";
import { glowBatch, type VoxelBatch } from "./batch";
import { noOutline, toonMaterial } from "./toon";

export interface TerrainHandle {
  group: Group;
  update(nowSeconds: number): void;
  dispose(): void;
}

/** Water surface sits slightly below the grassy plateau. */
export const WATER_LEVEL = -0.35 * BLOCK;

// Ring layout, as multiples of the island's grass radius (Rg) and BLOCK.
// Each ring is a closed loop of vertices; consecutive rings are stitched into a
// skirt. The first four rings form the flat top; the rest round the rim, lay a
// beach, and taper the cliff under the sea.
interface RingDef {
  /** Radius in world units at a given angle. */
  radius: (angleCoast: number, rg: number) => number;
  y: (topY: number) => number;
  /** true → painterly grass; otherwise a solid color. */
  flatTop: boolean;
  color?: keyof WorldPalette;
}

const RINGS: RingDef[] = [
  { radius: () => 0, y: (t) => t, flatTop: true },
  { radius: (_c, rg) => 0.44 * rg, y: (t) => t, flatTop: true },
  { radius: (_c, rg) => 0.74 * rg, y: (t) => t, flatTop: true },
  { radius: (_c, rg) => 0.92 * rg, y: (t) => t, flatTop: true },
  {
    radius: (_c, rg) => Number(rg),
    y: (t) => t - 0.55 * BLOCK,
    flatTop: false,
    color: "grassDark",
  },
  {
    radius: (c, rg) => rg + (0.7 + c * 1.5) * BLOCK,
    y: () => WATER_LEVEL + 0.25,
    flatTop: false,
    color: "sand",
  },
  {
    radius: (c, rg) => rg + (0.3 + c * 1.4) * BLOCK,
    y: () => WATER_LEVEL - 1.5 * BLOCK,
    flatTop: false,
    color: "cliff",
  },
  {
    radius: (c, rg) => Math.max(2 * BLOCK, rg - 2.2 * BLOCK + c * 1 * BLOCK),
    y: () => WATER_LEVEL - 4.4 * BLOCK,
    flatTop: false,
    color: "cliffDark",
  },
];

function rampGreen(t: number, palette: WorldPalette, out: Color): Color {
  const dark = new Color(palette.grassDark);
  const mid = new Color(palette.grass);
  const light = new Color(palette.grassLight);
  if (t < 0.5) return out.copy(dark).lerp(mid, clamp(t * 2, 0, 1));
  return out.copy(mid).lerp(light, clamp((t - 0.5) * 2, 0, 1));
}

// Big, slow painterly zones drifting across the meadow: warm sunlit yellow-green
// and cool shaded sage. Lifts the flat ground out of a single uniform green.
const WARM_MEADOW = new Color("#cfd87f");
const COOL_MEADOW = new Color("#6f9c83");

function buildIslandGeometry(island: IslandSpec, palette: WorldPalette): BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];

  const segs = Math.round(clamp(island.radiusBlocks * 2.4, 32, 112));
  const rg = island.radiusBlocks * BLOCK;
  const topY = islandSurfaceY(island);
  const cx = island.center.x;
  const cz = island.center.z;
  const seedA = stableNoise(`coastA:${island.name}:${island.clusterIndex}`) * Math.PI * 2;
  const seedB = stableNoise(`coastB:${island.name}`) * Math.PI * 2;
  const greenSeed = stableNoise(`green:${island.name}`) * Math.PI * 2;

  const tmp = new Color();
  const solid = new Color();

  function coastBulge(angle: number): number {
    const a = 0.5 + 0.5 * Math.sin(3 * angle + seedA);
    const b = 0.5 + 0.5 * Math.sin(5 * angle - seedB);
    return a * 0.68 + b * 0.32;
  }

  // Manual normals: the degenerate centre ring breaks computeVertexNormals, and
  // a flat-shaded top should always face straight up regardless of triangulation.
  function ringNormal(ring: RingDef): { nx: number; ny: number } {
    if (ring.flatTop) return { nx: 0, ny: 1 };
    if (ring.color === "sand") return { nx: 0.7, ny: 1 };
    if (ring.color === "cliff") return { nx: 1.1, ny: 0.55 };
    if (ring.color === "cliffDark") return { nx: 1.15, ny: 0.4 };
    return { nx: 0.4, ny: 1 }; // rim roundover
  }

  for (const ring of RINGS) {
    const { nx, ny } = ringNormal(ring);
    for (let s = 0; s <= segs; s++) {
      const angle = (s / segs) * Math.PI * 2;
      const cosA = Math.cos(angle);
      const sinA = Math.sin(angle);
      const bulge = coastBulge(angle);
      const radius = ring.radius(bulge, rg);
      const x = cx + cosA * radius;
      const z = cz + sinA * radius;
      const y = ring.y(topY);
      positions.push(x, y, z);

      const len = Math.hypot(cosA * nx, ny, sinA * nx) || 1;
      normals.push((cosA * nx) / len, ny / len, (sinA * nx) / len);

      if (ring.flatTop) {
        const n =
          0.5 +
          0.26 * Math.sin(x * 0.05 + z * 0.031 + greenSeed) +
          0.24 * Math.sin(x * 0.018 - z * 0.043 - greenSeed);
        rampGreen(clamp(n, 0, 1), palette, tmp);
        // Drift into warm/cool meadow zones on a much larger, slower wave.
        const zone = Math.sin(x * 0.012 + z * 0.0135 + greenSeed * 1.7);
        if (zone > 0.2) tmp.lerp(WARM_MEADOW, (zone - 0.2) * 0.55);
        else if (zone < -0.2) tmp.lerp(COOL_MEADOW, (-zone - 0.2) * 0.45);
        colors.push(tmp.r, tmp.g, tmp.b);
      } else {
        solid.set(palette[ring.color ?? "grassDark"] as string);
        colors.push(solid.r, solid.g, solid.b);
      }
    }
  }

  const stride = segs + 1;
  for (let r = 0; r < RINGS.length - 1; r++) {
    for (let s = 0; s < segs; s++) {
      const a = r * stride + s;
      const b = a + 1;
      const c = (r + 1) * stride + s;
      const d = c + 1;
      // Wound so the flat top faces up (front side) — otherwise the surface is
      // back-face culled and only the dark inverted-hull outline shows through.
      indices.push(a, b, c, b, d, c);
    }
  }

  // Bottom cap so the island reads solid from below.
  const centerIndex = positions.length / 3;
  positions.push(cx, WATER_LEVEL - 5.4 * BLOCK, cz);
  solid.set(palette.cliffDark);
  colors.push(solid.r, solid.g, solid.b);
  normals.push(0, -1, 0);
  const lastRingStart = (RINGS.length - 1) * stride;
  for (let s = 0; s < segs; s++) {
    indices.push(lastRingStart + s + 1, lastRingStart + s, centerIndex);
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new Float32BufferAttribute(colors, 3));
  geometry.setAttribute("normal", new Float32BufferAttribute(normals, 3));
  geometry.setIndex(indices);
  return geometry;
}

function buildFoam(islands: readonly IslandSpec[], palette: WorldPalette): VoxelBatch {
  let capacity = 0;
  for (const island of islands) {
    capacity += Math.ceil((Math.PI * 2 * island.radiusBlocks) / 1.4);
  }
  const foam = glowBatch(Math.max(1, capacity), false, 0.6);
  for (const island of islands) {
    const dots = Math.ceil((Math.PI * 2 * island.radiusBlocks) / 1.4);
    for (let index = 0; index < dots; index++) {
      const angle =
        (index / dots) * Math.PI * 2 + stableNoise(`foam:${island.clusterIndex}:${index}`) * 0.3;
      const ring =
        (island.radiusBlocks + 1.2 + stableNoise(`foamr:${island.clusterIndex}:${index}`) * 1.3) *
        BLOCK;
      const size = 2 + stableNoise(`foams:${island.clusterIndex}:${index}`) * 2.6;
      foam.add({
        x: island.center.x + Math.cos(angle) * ring,
        y: WATER_LEVEL + 0.45,
        z: island.center.z + Math.sin(angle) * ring,
        sx: size,
        sy: 0.4,
        sz: size,
        color: palette.foam,
      });
    }
  }
  foam.commit();
  return foam;
}

export function createTerrain(
  _islands: readonly IslandSpec[],
  palette: WorldPalette,
  worldRadiusUnits: number,
): TerrainHandle {
  const group = new Group();

  // ONE landmass big enough to hold every village district plus a grassy margin
  // and a beach out to the shore. A single flat plateau at y=0 — the villages
  // (folders) are just regions on it, with open countryside between them.
  // 1.14× so the flat top (which the rings round off past ~0.92R) still covers
  // every district out to worldRadius, then a few blocks of beach beyond.
  const landRadiusBlocks = Math.ceil((worldRadiusUnits / BLOCK) * 1.14) + 4;
  const mainland: IslandSpec = {
    clusterIndex: 0,
    name: "mainland",
    center: new Vector3(0, 0, 0),
    radiusBlocks: landRadiusBlocks,
    elevation: ISLAND_ELEVATION,
    plotCount: 0,
  };
  const landGeometry = buildIslandGeometry(mainland, palette);
  const landMaterial = toonMaterial(palette, { vertexColors: true, outlineThickness: 0.0024 });
  const land = new Mesh(landGeometry, landMaterial);
  group.add(land);

  // Ocean — one big flat disc, plus a deep tint slab beneath.
  const oceanRadius = Math.max(worldRadiusUnits * 2.6, 1_600);
  const oceanGeometry = new RingGeometry(0, oceanRadius, 96, 1);
  const oceanMaterial = new MeshToonMaterial({ color: palette.water });
  noOutline(oceanMaterial);
  const ocean = new Mesh(oceanGeometry, oceanMaterial);
  ocean.rotation.x = -Math.PI / 2;
  ocean.position.y = WATER_LEVEL;
  group.add(ocean);

  const deepGeometry = new RingGeometry(0, oceanRadius, 48, 1);
  const deepMaterial = new MeshToonMaterial({ color: palette.waterDeep });
  noOutline(deepMaterial);
  const deep = new Mesh(deepGeometry, deepMaterial);
  deep.rotation.x = -Math.PI / 2;
  deep.position.y = WATER_LEVEL - 2.4 * BLOCK;
  group.add(deep);

  // Wave-line ripples — faint concentric rings hugging each shore.
  const rippleMaterial = new MeshToonMaterial({
    color: palette.waveLine,
    transparent: true,
    opacity: 0.5,
  });
  noOutline(rippleMaterial);
  const rippleGeometries: BufferGeometry[] = [];
  for (let r = 0; r < 4; r++) {
    const inner = (mainland.radiusBlocks + 2.4 + r * 3.2) * BLOCK;
    const ring = new RingGeometry(inner, inner + (0.7 - r * 0.12) * BLOCK, 128, 1);
    ring.rotateX(-Math.PI / 2);
    ring.translate(mainland.center.x, WATER_LEVEL + 0.12, mainland.center.z);
    rippleGeometries.push(ring);
  }
  let ripples: Mesh | null = null;
  if (rippleGeometries.length > 0) {
    const rippleGeometry = mergeGeometries(rippleGeometries);
    for (const geometry of rippleGeometries) geometry.dispose();
    ripples = new Mesh(rippleGeometry, rippleMaterial);
    group.add(ripples);
  }

  // Shore foam around the single coastline.
  const foam = buildFoam([mainland], palette);
  group.add(foam.mesh);
  const foamMaterial = foam.mesh.material as { opacity: number; transparent: boolean };

  function update(nowSeconds: number): void {
    // Gentle, slow shimmer on the shoreline so the water reads alive without
    // ever sliding (a soft breathing of the foam line + ripple rings).
    foamMaterial.opacity = 0.52 + Math.sin(nowSeconds * 1.1) * 0.16;
    rippleMaterial.opacity = 0.42 + Math.sin(nowSeconds * 0.8 + 1.3) * 0.14;
  }

  function dispose(): void {
    landGeometry.dispose();
    landMaterial.dispose();
    oceanGeometry.dispose();
    oceanMaterial.dispose();
    deepGeometry.dispose();
    deepMaterial.dispose();
    rippleMaterial.dispose();
    ripples?.geometry.dispose();
    foam.dispose();
  }

  return { group, update, dispose };
}
