import {
  normalizeCodeBlockLanguage,
  type CodeBlockPreviewEstimateContext,
  type CodeBlockPreviewRenderContext,
  type CodeBlockPreviewRenderer,
} from "~/plugins/builtin/core_editor/code_block_preview_renderers";

import { WIDGET_IFRAME_SANDBOX, buildWidgetIframeDocument } from "./iframe_document";
import { createWidgetProjectStore } from "./project_store";
import { normalizeKukuWidgetHeight, parseKukuWidgetAttrs } from "./widget_markdown";
import { WIDGET_IFRAME_DRAG_GUARD_ATTR } from "./widget_iframe_drag_guard";

const store = createWidgetProjectStore();

const widgetCodeBlockPreviewRenderer: CodeBlockPreviewRenderer = {
  id: "kuku-widget",
  matches: (language) => normalizeCodeBlockLanguage(language) === "kuku-widget",
  render: renderWidgetPreview,
  clear: (previewBody) => previewBody.replaceChildren(),
  estimateHeight: estimateWidgetPreviewHeight,
  previewOnly: true,
};

async function renderWidgetPreview(ctx: CodeBlockPreviewRenderContext): Promise<void> {
  const attrs = parseKukuWidgetAttrs(ctx.source);
  ctx.root.dataset.kukuWidgetCodeBlock = "";
  ctx.root.dataset.kukuCodeBlockPreviewOnly = "";
  ctx.previewBody.dataset.kukuWidgetPreview = "";
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
    ctx.previewBody.replaceChildren(
      createResizableWidgetFrame(ctx, attrs.id, attrs.height, iframe),
    );
  } catch {
    if (ctx.isCurrent()) {
      ctx.previewBody.textContent = `Widget not found: ${attrs.id}`;
    }
  }
}

function createResizableWidgetFrame(
  ctx: CodeBlockPreviewRenderContext,
  id: string,
  initialHeight: number,
  iframe: HTMLIFrameElement,
): HTMLElement {
  const shell = ctx.previewBody.ownerDocument.createElement("div");
  shell.dataset.kukuWidgetFrame = "";

  const handle = ctx.previewBody.ownerDocument.createElement("div");
  handle.dataset.kukuWidgetResizeHandle = "";
  handle.title = "Resize widget";

  handle.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = normalizeKukuWidgetHeight(Number.parseFloat(iframe.style.height));
    const restorePointerEvents = disableWidgetIframePointerEvents(ctx.editorRoot);

    const onMove = (moveEvent: PointerEvent) => {
      const height = normalizeKukuWidgetHeight(startHeight + moveEvent.clientY - startY);
      iframe.style.height = `${height}px`;
    };
    const onUp = (upEvent: PointerEvent) => {
      shell.ownerDocument.defaultView?.removeEventListener("pointermove", onMove);
      shell.ownerDocument.defaultView?.removeEventListener("pointerup", onUp);
      restorePointerEvents();
      const height = normalizeKukuWidgetHeight(startHeight + upEvent.clientY - startY);
      iframe.style.height = `${height}px`;
      ctx.updateSource?.(`id: ${id}\nheight: ${height}`);
    };

    shell.ownerDocument.defaultView?.addEventListener("pointermove", onMove);
    shell.ownerDocument.defaultView?.addEventListener("pointerup", onUp, { once: true });
  });

  shell.append(iframe, handle);
  if (initialHeight > 0) {
    iframe.style.height = `${initialHeight}px`;
  }
  return shell;
}

function disableWidgetIframePointerEvents(editorRoot: HTMLElement): () => void {
  const iframes = [
    ...editorRoot.querySelectorAll<HTMLIFrameElement>(`iframe[${WIDGET_IFRAME_DRAG_GUARD_ATTR}]`),
  ];
  const previousValues = iframes.map((iframe) => iframe.style.pointerEvents);
  for (const iframe of iframes) {
    iframe.style.pointerEvents = "none";
  }
  return () => {
    for (let index = 0; index < iframes.length; index += 1) {
      iframes[index].style.pointerEvents = previousValues[index] ?? "";
    }
  };
}

function estimateWidgetPreviewHeight(ctx: CodeBlockPreviewEstimateContext): number | null {
  return parseKukuWidgetAttrs(ctx.source)?.height ?? null;
}

export { widgetCodeBlockPreviewRenderer };
