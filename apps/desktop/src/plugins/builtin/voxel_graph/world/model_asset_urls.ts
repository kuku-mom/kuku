// ── Cached voxel model assets ──
//
// GLB files are intentionally not imported by Vite. The desktop app downloads
// them into the variant-aware global Kuku data root (~/.kuku*/voxel-assets)
// and then feeds GLTFLoader a Tauri asset URL.

import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";

const DEFAULT_MODEL_ASSET_BASE_URL =
  "https://raw.githubusercontent.com/kuku-mom/kuku/main/apps/desktop/src/plugins/builtin/voxel_graph/world/assets";

const configuredBaseUrl = import.meta.env.VITE_KUKU_VOXEL_ASSET_BASE_URL?.trim();
const modelAssetBaseUrl = (configuredBaseUrl || DEFAULT_MODEL_ASSET_BASE_URL).replace(/\/+$/, "");

export interface VoxelAssetCacheStatus {
  total: number;
  pending: number;
  completed: number;
  failed: number;
  current: string | null;
}

type VoxelAssetCacheStatusListener = (status: VoxelAssetCacheStatus) => void;

let cacheStatus: VoxelAssetCacheStatus = {
  total: 0,
  pending: 0,
  completed: 0,
  failed: 0,
  current: null,
};
const cacheStatusListeners = new Set<VoxelAssetCacheStatusListener>();

function snapshotCacheStatus(): VoxelAssetCacheStatus {
  return { ...cacheStatus };
}

function emitCacheStatus(): void {
  const snapshot = snapshotCacheStatus();
  for (const listener of cacheStatusListeners) listener(snapshot);
}

function beginCacheAsset(fileName: string): (ok: boolean) => void {
  if (cacheStatus.pending === 0) {
    cacheStatus = { total: 0, pending: 0, completed: 0, failed: 0, current: null };
  }

  let ended = false;
  cacheStatus = {
    ...cacheStatus,
    total: cacheStatus.total + 1,
    pending: cacheStatus.pending + 1,
    current: fileName,
  };
  emitCacheStatus();

  return (ok) => {
    if (ended) return;
    ended = true;
    cacheStatus = {
      ...cacheStatus,
      pending: Math.max(0, cacheStatus.pending - 1),
      completed: cacheStatus.completed + (ok ? 1 : 0),
      failed: cacheStatus.failed + (ok ? 0 : 1),
      current: cacheStatus.pending <= 1 ? null : cacheStatus.current,
    };
    emitCacheStatus();
  };
}

export function getVoxelAssetCacheStatus(): VoxelAssetCacheStatus {
  return snapshotCacheStatus();
}

export function onVoxelAssetCacheStatus(listener: VoxelAssetCacheStatusListener): () => void {
  cacheStatusListeners.add(listener);
  listener(snapshotCacheStatus());
  return () => {
    cacheStatusListeners.delete(listener);
  };
}

function sourceModelAssetUrl(fileName: string): string {
  return `${modelAssetBaseUrl}/${fileName}`;
}

async function cachedModelAssetUrl(fileName: string): Promise<string> {
  const sourceUrl = sourceModelAssetUrl(fileName);
  if (!isTauri()) return sourceUrl;

  const endCacheAsset = beginCacheAsset(fileName);
  try {
    const path = await invoke<string>("voxel_ensure_asset", { fileName, sourceUrl });
    endCacheAsset(true);
    return convertFileSrc(path);
  } catch (error) {
    endCacheAsset(false);
    console.warn(`failed to cache voxel model asset ${fileName}`, error);
    return sourceUrl;
  }
}

const CHARACTER_MODEL_FILES = [
  "kuku-red.glb",
  "kuku-orange.glb",
  "kuku-yellow.glb",
  "kuku-green.glb",
] as const;

const HOUSE_MODEL_FILES = [
  "kuku-house-1.glb",
  "kuku-house-2.glb",
  "kuku-house-3.glb",
  "kuku-house-4.glb",
] as const;

let characterModelUrlPromise: Promise<string[]> | null = null;
let houseModelUrlPromise: Promise<string[]> | null = null;

export function characterModelUrls(): Promise<string[]> {
  characterModelUrlPromise ??= Promise.all(CHARACTER_MODEL_FILES.map(cachedModelAssetUrl));
  return characterModelUrlPromise;
}

export function houseModelUrls(): Promise<string[]> {
  houseModelUrlPromise ??= Promise.all(HOUSE_MODEL_FILES.map(cachedModelAssetUrl));
  return houseModelUrlPromise;
}

export async function ensureVoxelModelAssets(): Promise<void> {
  await Promise.all([characterModelUrls(), houseModelUrls()]);
}
