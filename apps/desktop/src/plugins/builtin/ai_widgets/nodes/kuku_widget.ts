import { defineNodeSpec, type Extension } from "prosekit/core";

function defineKukuWidget(): Extension {
  return defineNodeSpec({
    name: "kukuWidget",
    group: "block",
    atom: true,
    isolating: true,
    selectable: true,
    attrs: {
      id: { default: "" },
      height: { default: 320 },
    },
    parseDOM: [
      {
        tag: "div[data-kuku-widget]",
        getAttrs(dom) {
          if (typeof dom === "string") return false;
          return {
            id: dom.getAttribute("data-widget-id") ?? "",
            height: Number(dom.getAttribute("data-height") ?? 320),
          };
        },
      },
    ],
    toDOM(node) {
      const attrs = node.attrs as { id?: string; height?: number };
      return [
        "div",
        {
          "data-kuku-widget": "",
          "data-widget-id": attrs.id ?? "",
          "data-height": String(attrs.height ?? 320),
        },
      ];
    },
  });
}

export { defineKukuWidget };
