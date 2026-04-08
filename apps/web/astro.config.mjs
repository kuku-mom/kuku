// @ts-check
import { defineConfig } from "astro/config";
import solid from "@astrojs/solid-js";

import { getSiteUrl } from "./src/config/site.ts";

export default defineConfig({
  site: getSiteUrl(),
  output: "static",
  integrations: [solid()],
  server: {
    allowedHosts: ["www.kuku.mom", "kuku.mom"],
  },
  vite: {
    resolve: {
      alias: {
        "@": "/src",
      },
    },
  },
});
