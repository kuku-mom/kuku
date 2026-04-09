// ── Horizontal Rule Node ──
//
// Defines the "horizontalRule" node for thematic breaks (---).
// Provides schema spec, insert command, and input rule.
//
// Vendored from ProseKit predefined extension with customizations.

import { defineCommands, defineNodeSpec, getNodeType, union, type Extension } from "prosekit/core";
import { defineInputRule } from "prosekit/extensions/input-rule";
import { InputRule } from "prosekit/pm/inputrules";
import { Fragment, Slice } from "prosekit/pm/model";

function defineHorizontalRuleSpec(): Extension {
  return defineNodeSpec({
    name: "horizontalRule",
    group: "block",
    parseDOM: [{ tag: "hr" }],
    toDOM() {
      return ["hr"];
    },
  });
}

function defineHorizontalRuleCommands(): Extension {
  return defineCommands({
    insertHorizontalRule: () => (state, dispatch) => {
      if (!dispatch) return true;
      const { schema, tr } = state;
      const node = getNodeType(schema, "horizontalRule").createChecked();
      const pos = tr.selection.anchor;
      tr.replaceRange(pos, pos, new Slice(Fragment.from(node), 0, 0));
      dispatch(tr);
      return true;
    },
  });
}

/**
 * Input rule: typing `---` at the start of a line inserts a horizontal rule.
 */
function defineHorizontalRuleInputRule(): Extension {
  return defineInputRule(
    new InputRule(/^---$/, (state, _match, start, end) => {
      const { schema, tr } = state;
      const node = getNodeType(schema, "horizontalRule").createChecked();
      tr.delete(start, end).insert(start - 1, node);
      return tr.scrollIntoView();
    }),
  );
}

function defineHorizontalRule(): Extension {
  return union(
    defineHorizontalRuleSpec(),
    defineHorizontalRuleCommands(),
    defineHorizontalRuleInputRule(),
  );
}

export { defineHorizontalRule };
