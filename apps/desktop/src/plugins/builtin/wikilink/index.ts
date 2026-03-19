// ── Wikilink Plugin ──
//
// Adds `[[wikilink]]` support to the editor:
//   - Remark plugin for parsing/serializing `[[target]]` / `[[target|alias]]`
//   - ProseMirror inline atom node with input rule and click navigation
//   - Markdown round-trip handlers (mdast ↔ PM JSON)

import type { KukuPlugin } from "~/plugins/types";

import { wikilinkMarkdown } from "./markdown_handlers";
import { defineWikilink } from "./nodes/wikilink";

const wikilinkPlugin: KukuPlugin = {
  id: "wikilink",
  name: "Wikilink",
  version: "0.1.0",
  description:
    "[[wikilink]] syntax: inline node, input rule, click-to-navigate, markdown round-trip",
  dependencies: ["editor-core"],

  editor: {
    extension: defineWikilink,
    markdown: wikilinkMarkdown,
  },
};

export { wikilinkPlugin };
