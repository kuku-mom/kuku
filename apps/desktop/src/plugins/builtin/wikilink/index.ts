// ── Wikilink Plugin ──
//
// Adds `[[wikilink]]` support to the editor:
//   - Remark plugin for parsing/serializing `[[target]]` / `[[target|alias]]`
//   - ProseMirror inline atom node with input rule
//   - Markdown round-trip handlers (mdast ↔ PM JSON)
//   - Anchor click handler: clicking a wikilink opens the target note

import type { KukuPlugin } from "~/plugins/types";

import { registerAnchorHandler } from "~/plugins/anchor_handlers";
import type { SearchService } from "~/plugins/builtin/core_indexer/service";
import { openTab } from "~/stores/files";
import { existsInTree, vaultState } from "~/stores/vault";

import { registerWikilinkAnchorEditHandler } from "./anchor_edit_handler";
import { wikilinkMarkdown } from "./markdown_handlers";
import { defineWikilink } from "./nodes/wikilink";

import "~/styles/wikilink.css";

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Extract the display text for a wikilink target.
 * Takes the last path segment and strips `.md` extension.
 */
function displayText(target: string): string {
  const segments = target.split("/");
  const last = segments[segments.length - 1] ?? target;
  return last.endsWith(".md") ? last.slice(0, -3) : last;
}

const wikilinkPlugin: KukuPlugin = {
  id: "wikilink",
  name: "Wikilink",
  version: "0.1.0",
  description:
    "[[wikilink]] syntax: inline node, input rule, click-to-navigate, markdown round-trip",
  dependencies: ["core-editor", "core-indexer"],

  editor: {
    extension: defineWikilink,
    markdown: wikilinkMarkdown,
  },

  activate(ctx) {
    const search = ctx.services.get("core-indexer.search") as SearchService | undefined;
    if (!search) {
      throw new Error("core-indexer.search service not found");
    }

    ctx.track(registerWikilinkAnchorEditHandler(() => ctx.editor.activeFilePath));

    // Register anchor click handler via the shared registry.
    // core_editor's click plugin dispatches to this when <a data-wikilink> is clicked.
    const dispose = registerAnchorHandler("a[data-wikilink]", (anchor) => {
      const target = anchor.getAttribute("data-target");
      if (!target) return false;

      const sourcePath = ctx.editor.activeFilePath;
      void search.resolveWikilink(sourcePath ?? "", target).then((resolved) => {
        const filePath = resolved.resolvedPath;
        if (!filePath) return;
        if (!existsInTree(vaultState.files, filePath)) return;
        openTab(displayText(target), filePath);
      });
      return true;
    });

    ctx.track(dispose);
  },
};

export { wikilinkPlugin };
