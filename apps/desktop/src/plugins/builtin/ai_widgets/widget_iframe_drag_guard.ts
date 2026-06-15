const WIDGET_IFRAME_DRAG_GUARD_ATTR = "data-kuku-widget-iframe";

function widgetIframeDragGuardAttrs(): Record<string, string> {
  return { [WIDGET_IFRAME_DRAG_GUARD_ATTR]: "" };
}

export { WIDGET_IFRAME_DRAG_GUARD_ATTR, widgetIframeDragGuardAttrs };
