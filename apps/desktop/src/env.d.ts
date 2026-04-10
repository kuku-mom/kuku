/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_KUKU_AI_SERVER_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
