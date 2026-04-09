// ── Image Node ──
//
// Defines the "image" node for block-level images with src/alt/width/height attrs.
// Provides schema spec and insert command.
//
// Vendored from ProseKit predefined extension with customizations.
// Upload support is NOT included — will be added separately if needed.

import { defineCommands, defineNodeSpec, insertNode, union, type Extension } from "prosekit/core";
import { defineInputRule } from "prosekit/extensions/input-rule";
import { InputRule } from "prosekit/pm/inputrules";

import { parseMarkdownLinkLikeSyntax } from "../markdown_input";

function defineImageSpec(): Extension {
  return defineNodeSpec({
    name: "image",
    attrs: {
      src: { default: null },
      alt: { default: null, validate: "string|null" },
      width: { default: null, validate: "number|null" },
      height: { default: null, validate: "number|null" },
    },
    group: "block",
    defining: true,
    draggable: true,
    parseDOM: [
      {
        tag: "img[src]",
        getAttrs: (element) => {
          if (typeof element === "string") return { src: null };
          const rect = element.getBoundingClientRect();
          const imageElement = element instanceof HTMLImageElement ? element : null;
          const width =
            rect.width > 0 ? Math.round(rect.width) : imageElement?.naturalWidth || null;
          const height =
            rect.height > 0 ? Math.round(rect.height) : imageElement?.naturalHeight || null;
          return {
            src: element.getAttribute("src") || null,
            alt: element.getAttribute("alt") || null,
            width,
            height,
          };
        },
      },
    ],
    toDOM(node) {
      const { src, alt, width, height } = node.attrs as {
        src: string | null;
        alt: string | null;
        width: number | null;
        height: number | null;
      };
      return [
        "img",
        {
          src: src ?? undefined,
          alt: alt ?? undefined,
          width: width ?? undefined,
          height: height ?? undefined,
        },
      ];
    },
  });
}

function defineImageCommands(): Extension {
  return defineCommands({
    insertImage: (attrs?: { src: string; alt?: string; width?: number; height?: number }) =>
      insertNode({ type: "image", attrs }),
  });
}

function defineMarkdownImageInputRule(): Extension {
  return defineInputRule(
    new InputRule(/!\[[\s\S]*\)$/, (state, match, start, end) => {
      const parsed = parseMarkdownLinkLikeSyntax(match[0] ?? "", {
        image: true,
        allowEmptyLabel: true,
      });
      if (!parsed) return null;

      const { schema, tr } = state;
      const image = schema.nodes.image.create({
        src: parsed.target,
        alt: parsed.label || null,
        width: null,
        height: null,
      });
      tr.delete(start, end).insert(start - 1, image);
      return tr.scrollIntoView();
    }),
  );
}

function defineImage(): Extension {
  return union(defineImageSpec(), defineImageCommands(), defineMarkdownImageInputRule());
}

export { defineImage };
