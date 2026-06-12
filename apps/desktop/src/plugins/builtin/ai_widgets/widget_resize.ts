import { normalizeKukuWidgetHeight } from "./widget_markdown";

function getWidgetResizeHeight(startHeight: number, startY: number, currentY: number): number {
  return normalizeKukuWidgetHeight(startHeight + currentY - startY);
}

function shouldStopWidgetNodeEventTarget(target: EventTarget | null): boolean {
  if (typeof HTMLIFrameElement !== "undefined" && target instanceof HTMLIFrameElement) {
    return true;
  }

  return (
    typeof Element !== "undefined" &&
    target instanceof Element &&
    target.closest("[data-kuku-widget-resize-handle], [data-kuku-widget-source]") !== null
  );
}

export { getWidgetResizeHeight, shouldStopWidgetNodeEventTarget };
