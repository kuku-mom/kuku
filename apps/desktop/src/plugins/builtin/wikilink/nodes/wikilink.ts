/**
 * Wikilink — ProseKit node spec, input rule, and click handler.
 *
 * Renders `[[target]]` / `[[target|alias]]` as inline atom nodes.
 */

import type { EditorView } from "prosekit/pm/view";

import { defineNodeSpec, definePlugin, union } from "prosekit/core";
import { defineInputRule } from "prosekit/extensions/input-rule";
import { InputRule } from "prosekit/pm/inputrules";
import { Plugin } from "prosekit/pm/state";

import { openTab } from "~/stores/files";
import { existsInTree, vaultState } from "~/stores/vault";

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

/**
 * Resolve a wikilink target to a full vault file path.
 * Appends `.md` if the target doesn't already end with it.
 */
function resolveTarget(target: string): string | null {
  const root = vaultState.rootPath;
  if (!root) return null;
  const normalized = target.endsWith(".md") ? target : `${target}.md`;
  return `${root}/${normalized}`;
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

// ── Click Handler ───────────────────────────────────────────────────

/**
 * Click handler plugin — clicking a wikilink opens the target note.
 */
function defineWikilinkClickHandler() {
  return definePlugin(
    new Plugin({
      props: {
        handleClick(view: EditorView, pos: number, event: MouseEvent) {
          if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return false;

          const resolved = view.state.doc.resolve(pos);
          const node = resolved.nodeAfter ?? resolved.nodeBefore;
          if (!node || node.type.name !== "wikilink") return false;

          const target = node.attrs.target as string;
          if (!target) return false;

          const filePath = resolveTarget(target);
          if (!filePath) return false;

          if (!existsInTree(vaultState.files, filePath)) return false;

          const fileName = displayText(target);
          openTab(fileName, filePath);
          return true;
        },
      },
    }),
  );
}

// ── Combined Extension ──────────────────────────────────────────────

function defineWikilink() {
  return union(defineWikilinkSpec(), defineWikilinkInputRule(), defineWikilinkClickHandler());
}

export { defineWikilink };
