import type { KukuPlugin } from "~/plugins/types";

import { createProxyToolRegistry } from "./registry";

const coreToolRegistryPlugin: KukuPlugin = {
  id: "core-tool-registry",
  name: "Tool Registry",
  version: "0.1.0",
  description: "Shared registry for AI-exposed proxy tools owned by other plugins",
  canDisable: false,

  activate(ctx) {
    const registry = createProxyToolRegistry();
    ctx.services.register("proxyTools", registry);
  },
};

export { coreToolRegistryPlugin };
