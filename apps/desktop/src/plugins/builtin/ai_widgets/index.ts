import { lazy } from "solid-js";

import { registerCodeBlockPreviewRenderer } from "~/plugins/builtin/core_editor/code_block_preview_renderers";
import type { AiProxyToolRegistry } from "~/plugins/builtin/core_tool_registry/types";
import type { KukuPlugin } from "~/plugins/types";

import { registerWidgetAiTools } from "./ai_tools";
import { widgetCodeBlockPreviewRenderer } from "./renderer";

const WidgetPanel = lazy(() => import("./widget_panel"));

const aiWidgetsPlugin: KukuPlugin = {
  id: "ai-widgets",
  name: "AI Widgets",
  version: "0.1.0",
  description: "AI-generated sandboxed widgets and visualizations",
  canDisable: true,
  dependencies: ["core-tool-registry", "core-editor"],

  views: [
    {
      id: "ai-widgets.panel",
      label: "Widgets",
      icon: "widgets",
      location: { slot: "rightPanel" },
      order: 20,
      component: WidgetPanel,
    },
  ],

  activate(ctx) {
    ctx.track(registerCodeBlockPreviewRenderer(widgetCodeBlockPreviewRenderer));

    const proxyTools = ctx.services.get("core-tool-registry.proxyTools") as
      | AiProxyToolRegistry
      | undefined;
    if (!proxyTools) return;

    ctx.track(registerWidgetAiTools(proxyTools));
  },
};

export { aiWidgetsPlugin };
