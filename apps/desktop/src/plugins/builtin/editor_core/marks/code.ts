// ── Code Mark (Inline) ──
//
// Defines the "code" mark for inline code spans.
// Provides schema spec and toggle command.

import { defineCommands, defineMarkSpec, toggleMark, union, type Extension } from "prosekit/core";
import { defineMarkInputRule } from "prosekit/extensions/input-rule";

function defineCodeSpec(): Extension {
  return defineMarkSpec({
    name: "code",
    parseDOM: [{ tag: "code" }],
    toDOM() {
      return ["code", 0];
    },
  });
}

function defineCodeCommands(): Extension {
  return defineCommands({
    toggleCode: () => toggleMark({ type: "code" }),
  });
}

/**
 * Input rule: wrapping text with `` `text` `` applies code mark.
 */
function defineCodeInputRule(): Extension {
  return defineMarkInputRule({
    regex: /(?<=\s|^)`([^\s`]|[^\s`][^`]*[^\s`])`$/,
    type: "code",
  });
}

function defineCode(): Extension {
  return union(defineCodeSpec(), defineCodeCommands(), defineCodeInputRule());
}

export { defineCode };
