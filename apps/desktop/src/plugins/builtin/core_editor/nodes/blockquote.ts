// ── Blockquote Node ──
//
// Defines the "blockquote" node for block-level quotations.
// Provides schema spec, toggle/set/insert commands, wrapping input rule,
// and backspace keymap for unwrapping.
//
// Vendored from ProseKit predefined extension with customizations.

import {
  defineCommands,
  defineKeymap,
  defineNodeSpec,
  insertNode,
  isAtBlockStart,
  toggleWrap,
  union,
  wrap,
  type Extension,
} from "prosekit/core";
import { defineWrappingInputRule } from "prosekit/extensions/input-rule";
import { joinBackward } from "prosekit/pm/commands";

function defineBlockquoteSpec(): Extension {
  return defineNodeSpec({
    name: "blockquote",
    content: "block+",
    group: "block",
    defining: true,
    parseDOM: [{ tag: "blockquote" }],
    toDOM() {
      return ["blockquote", 0];
    },
  });
}

function defineBlockquoteCommands(): Extension {
  return defineCommands({
    setBlockquote: () => wrap({ type: "blockquote" }),
    insertBlockquote: () => insertNode({ type: "blockquote" }),
    toggleBlockquote: () => toggleWrap({ type: "blockquote" }),
  });
}

/**
 * Input rule: typing `> ` at the start of a line wraps in a blockquote.
 */
function defineBlockquoteInputRule(): Extension {
  return defineWrappingInputRule({
    regex: /^>\s/,
    type: "blockquote",
  });
}

/**
 * Keymap: Backspace at the start of a blockquote joins backward (unwraps).
 */
function defineBlockquoteKeymap(): Extension {
  return defineKeymap({
    Backspace: (state, dispatch, view) => {
      if (isAtBlockStart(state, view)?.node(-1).type.name === "blockquote") {
        return joinBackward(state, dispatch, view);
      }
      return false;
    },
  });
}

function defineBlockquote(): Extension {
  return union(
    defineBlockquoteSpec(),
    defineBlockquoteCommands(),
    defineBlockquoteInputRule(),
    defineBlockquoteKeymap(),
  );
}

export { defineBlockquote };
