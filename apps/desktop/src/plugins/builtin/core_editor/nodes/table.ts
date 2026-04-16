// ── Table Node ──
//
// Uses ProseKit's table schema / commands, but keeps only `tableEditing()`.
// Column resizing is intentionally disabled so tables stay content-driven
// and wrap inside the editor width instead of introducing horizontal drag UI.

import { definePlugin, union, type Extension } from "prosekit/core";
import {
  defineTableCellSpec,
  defineTableCommands,
  defineTableDropIndicator,
  defineTableHeaderCellSpec,
  defineTableRowSpec,
  defineTableSpec,
} from "prosekit/extensions/table";
import { tableEditing } from "prosemirror-tables";

function defineTable(): Extension {
  return union(
    defineTableSpec(),
    defineTableRowSpec(),
    defineTableCellSpec(),
    defineTableHeaderCellSpec(),
    definePlugin([tableEditing()]),
    defineTableCommands(),
    defineTableDropIndicator(),
  );
}

export { defineTable };
