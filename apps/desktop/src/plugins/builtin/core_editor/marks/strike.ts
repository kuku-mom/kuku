// ── Strike Mark ──
//
// Defines the "strike" mark for strikethrough text.
// Provides schema spec, toggle command, keyboard shortcuts, and input rule.
//
// Vendored from ProseKit predefined extension with customizations.

import {
  canUseRegexLookbehind,
  defineCommands,
  defineKeymap,
  defineMarkSpec,
  toggleMark,
  union,
  type Extension,
} from "prosekit/core";
import { defineMarkInputRule } from "prosekit/extensions/input-rule";

function defineStrikeSpec(): Extension {
  return defineMarkSpec({
    name: "strike",
    parseDOM: [
      { tag: "s" },
      { tag: "strike" },
      { tag: "del" },
      { style: "text-decoration=line-through" },
      { style: "text-decoration-line=line-through" },
    ],
    toDOM() {
      return ["s", 0];
    },
  });
}

function defineStrikeCommands(): Extension {
  return defineCommands({
    toggleStrike: () => toggleMark({ type: "strike" }),
  });
}

/**
 * Keymap: Mod-Shift-S toggles strikethrough.
 * (Mod-S is reserved for save, Mod-X for cut)
 */
function defineStrikeKeymap(): Extension {
  return defineKeymap({
    "Mod-Shift-KeyS": toggleMark({ type: "strike" }),
  });
}

/**
 * Input rule: wrapping text with `~~text~~` applies strike mark.
 */
function defineStrikeInputRule(): Extension {
  return defineMarkInputRule({
    regex: canUseRegexLookbehind()
      ? /(?<=\s|^)~~([^\s~]|[^\s~][^~]*[^\s~])~~$/
      : /~~([^\s~]|[^\s~][^~]*[^\s~])~~$/,
    type: "strike",
  });
}

function defineStrike(): Extension {
  return union(
    defineStrikeSpec(),
    defineStrikeCommands(),
    defineStrikeKeymap(),
    defineStrikeInputRule(),
  );
}

export { defineStrike };
