import type { KukuPlugin } from "~/plugins/types";

import { registerCodeBlockPreviewRenderer } from "~/plugins/builtin/core_editor/code_block_preview_renderers";

import { registerMermaidHighlightLanguage } from "./highlight";
import { mermaidCodeBlockPreviewRenderer } from "./renderer";

import "./mermaid.css";

const mermaidPlugin: KukuPlugin = {
  id: "mermaid",
  name: "Mermaid",
  version: "0.1.0",
  description: "Mermaid diagram preview rendering for fenced code blocks",
  canDisable: true,
  dependencies: ["core-editor"],

  activate(ctx) {
    registerMermaidHighlightLanguage();
    ctx.track(registerCodeBlockPreviewRenderer(mermaidCodeBlockPreviewRenderer));
  },
};

export { mermaidPlugin };
