import tailwindcss from "@tailwindcss/vite";
import autoprefixer from "autoprefixer";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

function chunkGroupName(id: string): string | null {
  const normalized = id.replaceAll("\\", "/");
  if (!normalized.includes("/node_modules/")) return null;

  if (normalized.includes("/three/build/three.webgpu.js")) return "vendor-three-webgpu";
  if (normalized.includes("/three/build/three.core.js")) return "vendor-three-core";
  if (normalized.includes("/three/build/three.module.js")) return "vendor-three-module";
  if (normalized.includes("/three/examples/jsm/controls/")) return "vendor-three-controls";
  if (normalized.includes("/three/examples/jsm/postprocessing/")) {
    return "vendor-three-postprocessing";
  }
  if (
    /\/(3d-force-graph|three-forcegraph|three-render-objects|three-spritetext|d3-|ngraph\.|kapsule|data-bind-mapper|float-tooltip|@tweenjs|polished|tinycolor2|lodash-es)@/.test(
      normalized,
    )
  ) {
    return "vendor-graph-3d";
  }
  if (normalized.includes("/pixi.js@") || normalized.includes("/@pixi/")) {
    return "vendor-pixi";
  }
  if (normalized.includes("/solid-js@")) return "vendor-solid";
  if (normalized.includes("/@tauri-apps+")) return "vendor-tauri";
  if (normalized.includes("/@kobalte+") || normalized.includes("/@floating-ui+")) {
    return "vendor-ui";
  }
  if (normalized.includes("/overlayscrollbars")) return "vendor-scroll";
  if (normalized.includes("/prosekit@") || normalized.includes("/prosemirror-")) {
    return "vendor-editor";
  }
  if (
    /\/(remark|micromark|mdast-|unified|vfile|bail|trough|decode-named-character-reference)@/.test(
      normalized,
    )
  ) {
    return "vendor-markdown";
  }
  if (normalized.includes("/@cfworker+json-schema")) return "vendor-json-schema";
  if (normalized.includes("/tailwind-merge@")) return "vendor-style";

  return null;
}

export default defineConfig({
  // Packaged Tauri windows may resolve the built index via file/custom
  // protocols, so production assets must stay relative to index.html.
  base: "./",
  plugins: [solid(), tailwindcss()],
  resolve: {
    alias: [
      {
        find: /^three\/webgpu$/,
        replacement: fileURLToPath(new URL("src/shims/three_webgpu.ts", import.meta.url)),
      },
      {
        find: "~",
        replacement: fileURLToPath(new URL("src", import.meta.url)),
      },
    ],
  },
  css: {
    postcss: {
      plugins: [autoprefixer()],
    },
  },
  build: {
    outDir: "./dist",
    emptyOutDir: true,
    rolldownOptions: {
      output: {
        codeSplitting: {
          includeDependenciesRecursively: false,
          maxSize: 460 * 1024,
          groups: [
            {
              name: chunkGroupName,
              test: (id) => chunkGroupName(id) !== null,
              priority: 10,
            },
            {
              name: "initial",
              tags: ["$initial"],
              priority: -1,
            },
          ],
        },
        chunkFileNames: "assets/chunk-[name]-[hash].js",
        entryFileNames: "assets/entry-[name]-[hash].js",
        assetFileNames: "assets/asset-[name]-[hash][extname]",
      },
    },
  },
});
