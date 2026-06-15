const LAYOUT_RESIZE_ACTIVE_ATTR = "data-kuku-layout-resizing";

function beginLayoutResizeDrag(doc: Document): void {
  doc.documentElement.setAttribute(LAYOUT_RESIZE_ACTIVE_ATTR, "");
}

function endLayoutResizeDrag(doc: Document): void {
  doc.documentElement.removeAttribute(LAYOUT_RESIZE_ACTIVE_ATTR);
}

export { LAYOUT_RESIZE_ACTIVE_ATTR, beginLayoutResizeDrag, endLayoutResizeDrag };
