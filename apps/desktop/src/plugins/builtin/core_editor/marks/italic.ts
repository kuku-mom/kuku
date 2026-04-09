// ── Italic Mark ──
//
// Defines the "italic" mark for the editor using ProseKit core primitives.
// Provides schema spec, toggle command, and keyboard shortcut.

import { defineCommands, defineMarkSpec, toggleMark, union, type Extension } from "prosekit/core";
import { defineMarkInputRule } from "prosekit/extensions/input-rule";

function defineItalicSpec(): Extension {
  return defineMarkSpec({
    name: "italic",
    parseDOM: [
      { tag: "em" },
      { tag: "i" },
      {
        style: "font-style",
        getAttrs: (value) => {
          if (value === "italic") {
            return {};
          }
          return false;
        },
      },
    ],
    toDOM() {
      return ["em", 0];
    },
  });
}

function defineItalicCommands(): Extension {
  return defineCommands({
    toggleItalic: () => toggleMark({ type: "italic" }),
  });
}

/**
 * Input rule: wrapping text with `*text*` applies italic mark.
 */
function defineItalicInputRule(): Extension {
  return defineMarkInputRule({
    regex: /(?<=\s|^)\*([^\s*]|[^\s*][^*]*[^\s*])\*$/,
    type: "italic",
  });
}

function defineItalic(): Extension {
  return union(defineItalicSpec(), defineItalicCommands(), defineItalicInputRule());
}

export { defineItalic };
