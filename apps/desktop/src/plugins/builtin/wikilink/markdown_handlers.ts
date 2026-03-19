/**
 * Wikilink — Markdown ↔ PM JSON conversion handlers.
 *
 * These handlers bridge mdast WikiLink nodes and ProseMirror wikilink atoms.
 */

import type { MdastToPmInlineHandler, PMNodeJSON, PmToMdastInlineHandler } from "~/lib/markdown";
import type { MarkdownContribution } from "~/plugins/types";

import type { WikiLink } from "./remark_wikilink/types";
import { remarkWikilink } from "./remark_wikilink";

// ── mdast → PM ──────────────────────────────────────────────────────

const wikilinkMdastToPm: MdastToPmInlineHandler = (node) => {
  const wl = node as unknown as WikiLink;
  const attrs: Record<string, unknown> = { target: wl.target };
  if (wl.alias != null && wl.alias !== "") {
    attrs.alias = wl.alias;
  }
  return [{ type: "wikilink", attrs } as PMNodeJSON];
};

// ── PM → mdast ──────────────────────────────────────────────────────

const wikilinkPmToMdast: PmToMdastInlineHandler = (node) => {
  const target = (node.attrs?.target as string) ?? "";
  const alias = (node.attrs?.alias as string) ?? undefined;
  return {
    type: "wikilink",
    target,
    alias,
    value: alias ?? target,
  } as unknown as WikiLink;
};

// ── MarkdownContribution ────────────────────────────────────────────

export const wikilinkMarkdown: MarkdownContribution = {
  remarkPlugins: [remarkWikilink],
  mdastToPm: {
    inline: {
      wikilink: wikilinkMdastToPm,
    },
  },
  pmToMdast: {
    inline: {
      wikilink: wikilinkPmToMdast,
    },
  },
};
