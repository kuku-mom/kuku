import { defineNodeSpec, type Extension } from "prosekit/core";

function defineKukuFrontmatter(): Extension {
  return defineNodeSpec({
    name: "kukuFrontmatter",
    group: "block",
    atom: true,
    isolating: true,
    selectable: false,
    attrs: {
      value: { default: "" },
    },
    parseDOM: [
      {
        tag: "pre[data-kuku-frontmatter]",
        preserveWhitespace: "full",
        getAttrs(dom) {
          if (typeof dom === "string") return false;
          const value = dom.getAttribute("data-value") ?? dom.textContent ?? "";
          return { value: unwrapFrontmatter(value) };
        },
      },
    ],
    toDOM(node) {
      const rawValue = (node.attrs as { value?: unknown }).value;
      const value = typeof rawValue === "string" ? rawValue : "";
      return [
        "pre",
        {
          "data-kuku-frontmatter": "",
          "data-value": value,
        },
        ["code", {}, `---\n${value}\n---`],
      ];
    },
  });
}

function unwrapFrontmatter(value: string): string {
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  const match = /^---\n([\s\S]*?)\n---$/.exec(normalized);
  return match ? match[1] : value;
}

export { defineKukuFrontmatter };
