// ── Detailed 3D character models ──
//
// Loads several rigged, textured GLB characters (proper anime kids sculpted by
// image-to-3D), re-skins them with the world's cel/ink look, and hands out
// independently animated clones — one per agent — each playing the walk clip.
// Agents pick a variant by hash so a crowd reads as a varied cast.

import {
  AnimationMixer,
  Box3,
  Color,
  MeshToonMaterial,
  type AnimationAction,
  type AnimationClip,
  type BufferGeometry,
  type Material,
  type Mesh,
  type MeshStandardMaterial,
  type Object3D,
  type Texture,
} from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";

import type { WorldPalette } from "./palette";

import kukuGreen from "./assets/kuku-green.glb";
import kukuOrange from "./assets/kuku-orange.glb";
import kukuRed from "./assets/kuku-red.glb";
import kukuYellow from "./assets/kuku-yellow.glb";
import { getToonGradient, inkOutline } from "./toon";

const VARIANT_URLS: string[] = [kukuRed, kukuOrange, kukuYellow, kukuGreen];

interface Variant {
  template: Object3D;
  walkClip: AnimationClip | null;
  unitHeight: number;
}

type Status = "idle" | "loading" | "ready" | "failed";

const variants: Variant[] = [];
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

function disposeObjectResources(root: Object3D): void {
  const disposedGeometries = new Set<BufferGeometry>();
  const disposedMaterials = new Set<Material>();
  const disposedTextures = new Set<Texture>();
  root.traverse((object) => {
    const mesh = object as Mesh;
    if (!mesh.isMesh) return;
    if (!disposedGeometries.has(mesh.geometry)) {
      disposedGeometries.add(mesh.geometry);
      mesh.geometry.dispose();
    }
    disposeMaterial(mesh.material, disposedMaterials, disposedTextures);
  });
  root.clear();
}

/** Kick off the one-time async load of every variant. Safe to call repeatedly. */
export function loadCharacterModel(palette: WorldPalette): void {
  if (status !== "idle") return;
  status = "loading";
  const generation = loadGeneration;
  const loader = new GLTFLoader();
  const gradient = getToonGradient();
  // Load sequentially so several large embedded textures don't race and fail.
  void (async () => {
    for (const url of VARIANT_URLS) {
      try {
        const gltf = await loader.loadAsync(url);
        if (generation !== loadGeneration) {
          disposeObjectResources(gltf.scene);
          continue;
        }
        const scene = gltf.scene;
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
          toon.userData.outlineParameters = inkOutline(palette, 0.0028);
          mesh.material = toon;
        });
        const box = new Box3().setFromObject(scene);
        variants.push({
          template: scene,
          walkClip: gltf.animations[0] ?? null,
          unitHeight: box.max.y - box.min.y || 1,
        });
      } catch {
        // Skip a variant that fails to load.
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

/** Resolves once the models are ready or have failed. */
export function onCharacterModel(cb: () => void): () => void {
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

export function characterVariantCount(): number {
  return variants.length;
}

export interface CharacterInstance {
  root: Object3D;
  /** Distance from the agent's ground point up to the model's feet (≈0 for foot-origin rigs). */
  footOffset: number;
  setMoving(moving: boolean): void;
  update(deltaSeconds: number): void;
  dispose(): void;
}

const tmpBox = new Box3();

/** Builds an independent animated clone of a variant, scaled to `targetHeight`. */
export function makeCharacterInstance(
  variant: number,
  targetHeight: number,
): CharacterInstance | null {
  if (variants.length === 0) return null;
  const entry = variants[((variant % variants.length) + variants.length) % variants.length];
  const root = cloneSkinned(entry.template);
  root.scale.setScalar(targetHeight / entry.unitHeight);

  // Per-clone material wrappers keep instance disposal independent without
  // mutating the shared GLB templates.
  const ownMaterials: MeshToonMaterial[] = [];
  root.traverse((object) => {
    const mesh = object as Mesh;
    if (!mesh.isMesh) return;
    const cloned = (mesh.material as Material).clone() as MeshToonMaterial;
    mesh.material = cloned;
    ownMaterials.push(cloned);
  });

  tmpBox.setFromObject(root);
  const footOffset = -tmpBox.min.y;

  const mixer = new AnimationMixer(root);
  let action: AnimationAction | null = null;
  if (entry.walkClip) {
    action = mixer.clipAction(entry.walkClip);
    action.play();
  }
  let moving = true;

  return {
    root,
    footOffset,
    setMoving: (value) => {
      if (action && value !== moving) action.paused = !value;
      moving = value;
    },
    update: (deltaSeconds) => mixer.update(deltaSeconds),
    dispose: () => {
      mixer.stopAllAction();
      mixer.uncacheRoot(root);
      for (const mat of ownMaterials) mat.dispose();
      root.clear();
    },
  };
}

export function disposeCharacterModels(): void {
  loadGeneration += 1;
  for (const variant of variants) disposeObjectResources(variant.template);
  variants.length = 0;
  waiters.length = 0;
  status = "idle";
}

export const CHARACTER_FORWARD_OFFSET = 0; // GLB already faces +Z, matching agent heading.
