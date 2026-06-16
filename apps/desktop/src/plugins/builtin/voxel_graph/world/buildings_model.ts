// ── Detailed 3D house models (instanced) ──
//
// Loads a few textured GLB houses (sculpted by image-to-3D), re-skins them with
// the world's cel/ink look, and bakes each variant into reusable instancing
// "parts" — one geometry+material per sub-mesh, normalised so its base sits at
// y=0 and centred in XZ. buildings.ts then renders every plot of a variant as a
// single InstancedMesh, so a thousand houses cost a handful of draw calls
// instead of a thousand clones.

import {
  Box3,
  Color,
  MeshToonMaterial,
  Vector3,
  type BufferGeometry,
  type Material,
  type Mesh,
  type MeshStandardMaterial,
  type Texture,
} from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { SimplifyModifier } from "three/examples/jsm/modifiers/SimplifyModifier.js";

import kukuHouse1 from "./assets/kuku-house-1.glb";
import kukuHouse2 from "./assets/kuku-house-2.glb";
import kukuHouse3 from "./assets/kuku-house-3.glb";
import kukuHouse4 from "./assets/kuku-house-4.glb";
import type { WorldPalette } from "./palette";
import { getToonGradient, inkOutline } from "./toon";

// Four image-to-3D house designs: countryside cottage, two-storey suburban,
// traditional engawa cottage, and a steep-gabled house.
const VARIANT_URLS: string[] = [kukuHouse1, kukuHouse2, kukuHouse3, kukuHouse4];

/** One instancing-ready sub-mesh of a house: baked geometry + its cel material. */
export interface HousePart {
  geometry: BufferGeometry;
  material: MeshToonMaterial;
}

/** A house variant prepared for instancing. */
export interface HouseVariant {
  parts: HousePart[];
  /** Larger XZ footprint side of the variant (template units). */
  footprint: number;
  /** XZ centre of the variant's bounding box (template units). */
  centerX: number;
  centerZ: number;
  /** Bounding-box floor in template units (so instances can sit on the ground). */
  minY: number;
  /** Bounding-box height in template units. */
  height: number;
}

type Status = "idle" | "loading" | "ready" | "failed";

const variants: HouseVariant[] = [];
let status: Status = "idle";
const waiters: (() => void)[] = [];
let loadGeneration = 0;

const MATERIAL_TEXTURE_KEYS = [
  "map",
  "alphaMap",
  "aoMap",
  "bumpMap",
  "displacementMap",
  "emissiveMap",
  "envMap",
  "lightMap",
  "metalnessMap",
  "normalMap",
  "roughnessMap",
] as const;

type MaterialWithTextures = Material &
  Partial<Record<(typeof MATERIAL_TEXTURE_KEYS)[number], Texture | null>>;

function firstMaterial(material: Material | Material[]): Material {
  return Array.isArray(material) ? material[0] : material;
}

function disposeMaterial(
  material: Material | Material[],
  disposedMaterials: Set<Material>,
  disposedTextures: Set<Texture>,
): void {
  const list = Array.isArray(material) ? material : [material];
  for (const item of list) {
    if (disposedMaterials.has(item)) continue;
    disposedMaterials.add(item);
    const textured = item as MaterialWithTextures;
    for (const key of MATERIAL_TEXTURE_KEYS) {
      const texture = textured[key];
      if (texture && !disposedTextures.has(texture)) {
        disposedTextures.add(texture);
        texture.dispose();
      }
    }
    item.dispose();
  }
}

function disposeSceneResources(scene: { traverse(cb: (object: unknown) => void): void }): void {
  const disposedGeometries = new Set<BufferGeometry>();
  const disposedMaterials = new Set<Material>();
  const disposedTextures = new Set<Texture>();
  scene.traverse((object) => {
    const mesh = object as Mesh;
    if (!mesh.isMesh) return;
    if (!disposedGeometries.has(mesh.geometry)) {
      disposedGeometries.add(mesh.geometry);
      mesh.geometry.dispose();
    }
    disposeMaterial(mesh.material, disposedMaterials, disposedTextures);
  });
}

function disposeSceneGeometries(scene: { traverse(cb: (object: unknown) => void): void }): void {
  const disposedGeometries = new Set<BufferGeometry>();
  scene.traverse((object) => {
    const mesh = object as Mesh;
    if (!mesh.isMesh || disposedGeometries.has(mesh.geometry)) return;
    disposedGeometries.add(mesh.geometry);
    mesh.geometry.dispose();
  });
}

function disposeHouseVariant(variant: HouseVariant): void {
  const disposedGeometries = new Set<BufferGeometry>();
  const disposedMaterials = new Set<Material>();
  const disposedTextures = new Set<Texture>();
  for (const part of variant.parts) {
    if (!disposedGeometries.has(part.geometry)) {
      disposedGeometries.add(part.geometry);
      part.geometry.dispose();
    }
    disposeMaterial(part.material, disposedMaterials, disposedTextures);
  }
}

/**
 * Loads + cel-shades the house GLBs and bakes them for instancing. For large
 * vaults (`plotCount` past a threshold) the dense image-to-3D geometry (~16k
 * triangles each) is decimated once with a quadric-edge-collapse simplifier, so
 * instancing thousands of houses doesn't push tens of millions of verts/frame.
 */
export function loadHouseModels(palette: WorldPalette, plotCount = 0): void {
  if (status !== "idle") return;
  status = "loading";
  const generation = loadGeneration;
  const loader = new GLTFLoader();
  const gradient = getToonGradient();
  const outline = inkOutline(palette, 0.0032);
  // Tier the decimation: small vaults keep full detail; medium ones get a gentle
  // reduction (still crisp up close); only very large vaults — where each house
  // is tiny on screen — are simplified hard.
  const removeRatio = plotCount > 1200 ? 0.78 : plotCount > 500 ? 0.5 : 0;
  const simplifier = removeRatio > 0 ? new SimplifyModifier() : null;
  // Load one at a time: decoding several large embedded textures at once races
  // and some texture blobs fail, leaving untextured (grey) houses.
  void (async () => {
    for (const url of VARIANT_URLS) {
      try {
        const gltf = await loader.loadAsync(url);
        if (generation !== loadGeneration) {
          disposeSceneResources(gltf.scene);
          continue;
        }
        const scene = gltf.scene;
        // Cel-shade every sub-mesh.
        scene.traverse((object) => {
          const mesh = object as Mesh;
          if (!mesh.isMesh) return;
          mesh.castShadow = false;
          mesh.receiveShadow = false;
          const source = firstMaterial(mesh.material) as MeshStandardMaterial;
          const toon = new MeshToonMaterial({
            map: source.map ?? null,
            color: source.color ? source.color.clone() : new Color("#ffffff"),
            gradientMap: gradient,
          });
          toon.userData.outlineParameters = outline;
          mesh.material = toon;
        });

        // Bake each sub-mesh's transform into its geometry (in scene-root space)
        // so all instances can share one geometry driven purely by an instance
        // matrix.
        scene.updateMatrixWorld(true);
        const box = new Box3().setFromObject(scene);
        const size = box.getSize(new Vector3());
        const center = box.getCenter(new Vector3());
        const parts: HousePart[] = [];
        scene.traverse((object) => {
          const mesh = object as Mesh;
          if (!mesh.isMesh) return;
          let geometry = mesh.geometry.clone();
          geometry.applyMatrix4(mesh.matrixWorld);
          if (simplifier) {
            const total = geometry.attributes.position.count;
            const remove = Math.floor(total * removeRatio);
            try {
              const reduced = simplifier.modify(geometry, remove);
              if (reduced.attributes.position && reduced.attributes.position.count > 60) {
                geometry.dispose();
                geometry = reduced;
              }
            } catch {
              // Keep the full-resolution geometry if simplification fails.
            }
          }
          parts.push({ geometry, material: mesh.material as MeshToonMaterial });
        });
        disposeSceneGeometries(scene);
        if (parts.length === 0) continue;
        variants.push({
          parts,
          footprint: Math.max(size.x, size.z) || 1,
          centerX: center.x,
          centerZ: center.z,
          minY: box.min.y,
          height: size.y || 1,
        });
      } catch {
        // Skip a variant that fails to load; others still populate the village.
      }
    }
    if (generation !== loadGeneration) return;
    status = variants.length > 0 ? "ready" : "failed";
    flush();
  })();
}

function flush(): void {
  const callbacks = waiters.splice(0);
  for (const cb of callbacks) cb();
}

export function onHouseModels(cb: () => void): () => void {
  if (status === "ready" || status === "failed") {
    cb();
    return () => {};
  }
  waiters.push(cb);
  return () => {
    const index = waiters.indexOf(cb);
    if (index !== -1) waiters.splice(index, 1);
  };
}

export function houseVariantCount(): number {
  return variants.length;
}

export function getHouseVariant(variant: number): HouseVariant | null {
  if (variants.length === 0) return null;
  return variants[((variant % variants.length) + variants.length) % variants.length];
}

export function disposeHouseModels(): void {
  loadGeneration += 1;
  for (const variant of variants) disposeHouseVariant(variant);
  variants.length = 0;
  waiters.length = 0;
  status = "idle";
}
