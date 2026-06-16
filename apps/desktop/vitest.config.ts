import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";
import solid from "vite-plugin-solid";

export default defineConfig({
  plugins: [solid({ ssr: true })],
  assetsInclude: ["**/*.glb"],
  resolve: {
    alias: {
      "~": fileURLToPath(new URL("src", import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: "node",
  },
});
