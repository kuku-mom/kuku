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
const WIDGET_RESIZE_MESSAGE_TYPE = "kuku-widget:resize";

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
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture?.(event.pointerId);

    const startY = event.clientY;
    const startHeight = normalizeKukuWidgetHeight(Number.parseFloat(iframe.style.height));
    const restorePointerEvents = disableWidgetIframePointerEvents(ctx.editorRoot);
    const scrollViewport = findWidgetScrollViewport(ctx.editorRoot);
    const previousUserSelect = target.ownerDocument.body.style.userSelect;
    const previousCursor = target.ownerDocument.body.style.cursor;
    let lastHeight = startHeight;

    shell.dataset.kukuWidgetResizing = "";
    target.ownerDocument.body.style.userSelect = "none";
    target.ownerDocument.body.style.cursor = "ns-resize";

    const resizeTo = (clientY: number) => {
      const height = normalizeKukuWidgetHeight(startHeight + clientY - startY);
      iframe.style.height = `${height}px`;
      keepWidgetCentered(scrollViewport, height - lastHeight);
      lastHeight = height;
      return height;
    };

    const cleanup = () => {
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
      target.removeEventListener("pointercancel", onCancel);
      target.removeEventListener("lostpointercapture", onCancel);
      delete shell.dataset.kukuWidgetResizing;
      restorePointerEvents();
      target.ownerDocument.body.style.userSelect = previousUserSelect;
      target.ownerDocument.body.style.cursor = previousCursor;
      try {
        target.releasePointerCapture?.(event.pointerId);
      } catch {
        // Pointer capture may already be gone after cancel/lostpointercapture.
      }
    };

    const onMove = (moveEvent: PointerEvent) => {
      moveEvent.preventDefault();
      resizeTo(moveEvent.clientY);
    };
    const onUp = (upEvent: PointerEvent) => {
      upEvent.preventDefault();
      const height = resizeTo(upEvent.clientY);
      shell.dataset.kukuWidgetUserSized = "";
      ctx.updateSource?.(`id: ${id}\nheight: ${height}`);
      cleanup();
    };
    const onCancel = (cancelEvent: PointerEvent) => {
      cancelEvent.preventDefault();
      cleanup();
    };

    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
    target.addEventListener("pointercancel", onCancel);
    target.addEventListener("lostpointercapture", onCancel);
  });

  shell.append(iframe, handle);
  if (initialHeight > 0) {
    iframe.style.height = `${initialHeight}px`;
  }
  listenForWidgetResizeMessages(ctx, id, iframe, shell);
  return shell;
}

function listenForWidgetResizeMessages(
  ctx: CodeBlockPreviewRenderContext,
  id: string,
  iframe: HTMLIFrameElement,
  shell: HTMLElement,
): void {
  const win = shell.ownerDocument.defaultView;
  if (!win) return;

  const onMessage = (event: MessageEvent) => {
    if (!shell.isConnected) {
      win.removeEventListener("message", onMessage);
      return;
    }
    if (event.source !== iframe.contentWindow) return;
    if (!isWidgetResizeMessage(event.data)) return;
    if (shell.dataset.kukuWidgetResizing !== undefined) return;
    if (shell.dataset.kukuWidgetUserSized !== undefined) return;

    const height = normalizeKukuWidgetHeight(event.data.height);
    const currentHeight = normalizeKukuWidgetHeight(Number.parseFloat(iframe.style.height));
    if (height <= currentHeight) return;

    iframe.style.height = `${height}px`;
    ctx.updateSource?.(`id: ${id}\nheight: ${height}`);
  };

  win.addEventListener("message", onMessage);
}

function isWidgetResizeMessage(data: unknown): data is { height: number } {
  if (typeof data !== "object" || data === null) return false;
  const candidate = data as { type?: unknown; height?: unknown };
  return candidate.type === WIDGET_RESIZE_MESSAGE_TYPE && typeof candidate.height === "number";
}

function findWidgetScrollViewport(editorRoot: HTMLElement): HTMLElement | null {
  return (
    editorRoot.closest<HTMLElement>("[data-scroll-area-viewport]") ??
    editorRoot.ownerDocument.querySelector<HTMLElement>(
      "[data-editor-scroll] [data-scroll-area-viewport]",
    )
  );
}

function keepWidgetCentered(viewport: HTMLElement | null, heightDelta: number): void {
  if (!viewport || heightDelta === 0) return;
  viewport.scrollTop += heightDelta / 2;
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
