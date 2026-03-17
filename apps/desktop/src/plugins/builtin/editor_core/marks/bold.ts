// ── Bold Mark ──
//
// Defines the "bold" mark for the editor using ProseKit core primitives.
// Provides schema spec, toggle command, and keyboard shortcut.

import { defineCommands, defineMarkSpec, toggleMark, union, type Extension } from "prosekit/core";
import { defineMarkInputRule } from "prosekit/extensions/input-rule";

function defineBoldSpec(): Extension {
  return defineMarkSpec({
    name: "bold",
    parseDOM: [
      { tag: "strong" },
      { tag: "b" },
      {
        style: "font-weight",
        getAttrs: (value) => {
          if (typeof value === "string" && /^(bold|[7-9]\d{2,})$/.test(value)) {
            return {};
          }
          return false;
        },
      },
    ],
    toDOM() {
      return ["strong", 0];
    },
  });
}

function defineBoldCommands(): Extension {
  return defineCommands({
    toggleBold: () => toggleMark({ type: "bold" }),
  });
}

/**
 * Input rule: wrapping text with `**text**` applies bold mark.
 */
function defineBoldInputRule(): Extension {
  return defineMarkInputRule({
    regex: /(?<=\s|^)\*\*([^\s*]|[^\s*][^*]*[^\s*])\*\*$/,
    type: "bold",
  });
}

function defineBold(): Extension {
  return union(defineBoldSpec(), defineBoldCommands(), defineBoldInputRule());
}

export { defineBold };
