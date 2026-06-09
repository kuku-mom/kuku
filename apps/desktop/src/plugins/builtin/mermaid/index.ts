import type { KukuPlugin } from "~/plugins/types";

import { registerCodeBlockPreviewRenderer } from "~/plugins/builtin/core_editor/code_block_preview_renderers";

import { registerMermaidHighlightLanguage } from "./highlight";
import { clearMermaidRenderQueue } from "./render_queue";
import { mermaidCodeBlockPreviewRenderer } from "./renderer";
import { clearMermaidPreviewRuntimeCache } from "./runtime_cache";

import "./mermaid.css";

// Keep Mermaid fences syntax-highlighted when diagram rendering is disabled.
registerMermaidHighlightLanguage();

const mermaidPreviewPlugin: KukuPlugin = {
  id: "mermaid-preview",
  name: "Mermaid Preview",
  version: "0.1.0",
  description: "Mermaid diagram preview rendering for fenced code blocks",
  canDisable: true,
  dependencies: ["core-editor"],

  activate(ctx) {
    ctx.track(registerCodeBlockPreviewRenderer(mermaidCodeBlockPreviewRenderer));
    ctx.track(() => {
      clearMermaidRenderQueue();
      clearMermaidPreviewRuntimeCache();
    });
  },
};

export { mermaidPreviewPlugin };
