import {
  normalizeCodeBlockLanguage,
  type CodeBlockPreviewEstimateContext,
  type CodeBlockPreviewRenderContext,
  type CodeBlockPreviewRenderer,
} from "~/plugins/builtin/core_editor/code_block_preview_renderers";

import { WIDGET_IFRAME_SANDBOX, buildWidgetIframeDocument } from "./iframe_document";
import { createWidgetProjectStore } from "./project_store";
import { parseKukuWidgetAttrs } from "./widget_markdown";
import { WIDGET_IFRAME_DRAG_GUARD_ATTR } from "./widget_iframe_drag_guard";

const store = createWidgetProjectStore();

const widgetCodeBlockPreviewRenderer: CodeBlockPreviewRenderer = {
  id: "kuku-widget",
  matches: (language) => normalizeCodeBlockLanguage(language) === "kuku-widget",
  render: renderWidgetPreview,
  clear: (previewBody) => previewBody.replaceChildren(),
  estimateHeight: estimateWidgetPreviewHeight,
};

async function renderWidgetPreview(ctx: CodeBlockPreviewRenderContext): Promise<void> {
  const attrs = parseKukuWidgetAttrs(ctx.source);
  ctx.previewBody.replaceChildren();

  if (!attrs) {
    ctx.previewBody.textContent = "Invalid widget embed";
    return;
  }

  try {
    const project = await store.read(attrs.id);
    if (!ctx.isCurrent()) return;

    const iframe = ctx.previewBody.ownerDocument.createElement("iframe");
    iframe.setAttribute(WIDGET_IFRAME_DRAG_GUARD_ATTR, "");
    iframe.title = project.name || attrs.id;
    iframe.setAttribute("sandbox", WIDGET_IFRAME_SANDBOX);
    iframe.srcdoc = buildWidgetIframeDocument(project);
    iframe.style.cssText = `display:block;width:100%;height:${attrs.height}px;border:0;background:white`;
    ctx.previewBody.replaceChildren(iframe);
  } catch {
    if (ctx.isCurrent()) {
      ctx.previewBody.textContent = `Widget not found: ${attrs.id}`;
    }
  }
}

function estimateWidgetPreviewHeight(ctx: CodeBlockPreviewEstimateContext): number | null {
  return parseKukuWidgetAttrs(ctx.source)?.height ?? null;
}

export { widgetCodeBlockPreviewRenderer };
