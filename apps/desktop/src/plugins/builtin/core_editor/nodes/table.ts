// ── Table Node ──
//
// Defines the GFM table node using ProseKit's built-in table extension.
// No extra commands are added yet; the extension provides the schema,
// plugins, and selection/insert commands needed for tables.

import { defineTable as prosekitDefineTable } from "prosekit/extensions/table";
import type { Extension } from "prosekit/core";

function defineTable(): Extension {
  return prosekitDefineTable();
}

export { defineTable };
