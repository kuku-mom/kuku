import tailwindcss from "@tailwindcss/vite";
import autoprefixer from "autoprefixer";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig({
  // Packaged Tauri windows may resolve the built index via file/custom
  // protocols, so production assets must stay relative to index.html.
  base: "./",
  // Bundle 3D model binaries as URL assets (agent-world characters/houses).
  assetsInclude: ["**/*.glb"],
  plugins: [solid(), tailwindcss()],
  resolve: {
    alias: {
      "~": fileURLToPath(new URL("src", import.meta.url)),
    },
  },
  css: {
    postcss: {
      plugins: [autoprefixer()],
    },
  },
  build: {
    outDir: "./dist",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        chunkFileNames: "assets/chunk-[name]-[hash].js",
        entryFileNames: "assets/entry-[name]-[hash].js",
        assetFileNames: "assets/asset-[name]-[hash][extname]",
      },
    },
  },
});
