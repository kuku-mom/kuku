/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_KUKU_API_URL?: string;
  readonly VITE_KUKU_WEB_URL?: string;
  readonly VITE_KUKU_VOXEL_ASSET_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
