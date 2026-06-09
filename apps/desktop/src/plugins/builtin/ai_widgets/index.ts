import { type Component } from "solid-js";
import { union, type Extension } from "prosekit/core";

import type { AiProxyToolRegistry } from "~/plugins/builtin/core_tool_registry/types";
import type { KukuPlugin } from "~/plugins/types";

import { registerWidgetAiTools } from "./ai_tools";
import { aiWidgetMarkdown } from "./markdown_handlers";
import { defineKukuWidget } from "./nodes/kuku_widget";
import { WidgetEmbedNode, stopWidgetNodeEvent } from "./widget_embed_node";

function defineAiWidgetEditorExtension(): Extension {
  return union(defineKukuWidget());
}

const aiWidgetsPlugin: KukuPlugin = {
  id: "ai-widgets",
  name: "AI Widgets",
  version: "0.1.0",
  description: "AI-generated sandboxed widgets and visualizations",
  canDisable: true,
  dependencies: ["core-tool-registry", "core-editor"],

  editor: {
    extension: defineAiWidgetEditorExtension,
    nodeViews: {
      kukuWidget: {
        component: WidgetEmbedNode as unknown as Component,
        stopEvent: stopWidgetNodeEvent,
      },
    },
    markdown: aiWidgetMarkdown,
  },

  activate(ctx) {
    const proxyTools = ctx.services.get("core-tool-registry.proxyTools") as
      | AiProxyToolRegistry
      | undefined;
    if (!proxyTools) return;

    ctx.track(registerWidgetAiTools(proxyTools));
  },
};

export { aiWidgetsPlugin };
