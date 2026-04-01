/**
 * Wikilink — ProseKit node spec, input rule, and click handler.
 *
 * Renders `[[target]]` / `[[target|alias]]` as inline atom nodes.
 */

import { defineNodeSpec, union } from "prosekit/core";
import { defineInputRule } from "prosekit/extensions/input-rule";
import { InputRule } from "prosekit/pm/inputrules";

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Extract the display text for a wikilink.
 * - If alias is present, use alias.
 * - Otherwise, take the last path segment and strip `.md` extension.
 */
function displayText(target: string, alias?: string | null): string {
  if (alias) return alias;
  const segments = target.split("/");
  const last = segments[segments.length - 1] ?? target;
  return last.endsWith(".md") ? last.slice(0, -3) : last;
}

// ── Node Spec ───────────────────────────────────────────────────────

/**
 * Wikilink node spec — inline atom node with `target` and `alias` attrs.
 *
 * Renders as: `<a class="wikilink" data-wikilink data-target="..." data-alias="...">[[display]]</a>`
 */
function defineWikilinkSpec() {
  return defineNodeSpec({
    name: "wikilink",
    group: "inline",
    inline: true,
    atom: true,
    selectable: false,
    draggable: false,
    attrs: {
      target: { default: "" },
      alias: { default: null },
    },
    parseDOM: [
      {
        tag: "a[data-wikilink]",
        getAttrs(dom) {
          if (typeof dom === "string") return false;
          return {
            target: dom.getAttribute("data-target") ?? "",
            alias: dom.getAttribute("data-alias") || null,
          };
        },
      },
    ],
    toDOM(node) {
      const target = node.attrs.target as string;
      const alias = (node.attrs.alias as string | null) ?? undefined;
      const text = displayText(target, alias);
      return [
        "a",
        {
          class: "wikilink",
          "data-wikilink": "",
          "data-target": target,
          draggable: "false",
          ...(alias ? { "data-alias": alias } : {}),
        },
        `[[${text}]]`,
      ];
    },
  });
}

// ── Input Rule ──────────────────────────────────────────────────────

/**
 * Input rule: typing `[[target]]` or `[[target|alias]]` at the end of
 * input converts to a wikilink node.
 */
const WIKILINK_INPUT_REGEX = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]$/;

function defineWikilinkInputRule() {
  return defineInputRule(
    new InputRule(WIKILINK_INPUT_REGEX, (state, match, start, end) => {
      const target = match[1] ?? "";
      const alias = match[2] || null;
      const wikilinkType = state.schema.nodes.wikilink;
      if (!wikilinkType) return null;

      const node = wikilinkType.create({ target, alias });
      return state.tr.replaceWith(start, end, node);
    }),
  );
}

// ── Combined Extension ──────────────────────────────────────────────

function defineWikilink() {
  return union(defineWikilinkSpec(), defineWikilinkInputRule());
}

export { defineWikilink };
