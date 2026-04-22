import { NodeSelection, Selection } from "prosekit/pm/state";
import type { EditorView } from "prosekit/pm/view";

import {
  registerAnchorEditHandler,
  type AnchorEditTarget,
  type AnchorEditValues,
} from "~/plugins/anchor_editors";
import { vaultState } from "~/stores/vault";
import {
  filterWikilinkSuggestions,
  flattenMarkdownFiles,
} from "~/plugins/builtin/wikilink/wikilink_suggest";

interface WikilinkAnchorEditTarget extends AnchorEditTarget {
  pos: number;
}

function isEditorAnchor(view: EditorView, value: EventTarget | null): value is HTMLAnchorElement {
  return value instanceof HTMLAnchorElement && view.dom.contains(value);
}

function resolveWikilinkPosition(anchor: HTMLAnchorElement, view: EditorView): number | null {
  const candidates = [
    () => view.posAtDOM(anchor, 0),
    () => view.posAtDOM(anchor, anchor.childNodes.length),
  ];

  for (const candidate of candidates) {
    try {
      const pos = candidate();
      if (view.state.doc.nodeAt(pos)?.type.name === "wikilink") {
        return pos;
      }
      if (pos > 0 && view.state.doc.nodeAt(pos - 1)?.type.name === "wikilink") {
        return pos - 1;
      }
    } catch {
      // Ignore invalid DOM positions and try the next fallback.
    }
  }

  return null;
}

function createWikilinkAnchorEditTarget(
  anchor: HTMLAnchorElement,
  view: EditorView,
  getActiveFilePath?: () => string | null,
): WikilinkAnchorEditTarget | null {
  const pos = resolveWikilinkPosition(anchor, view);
  if (pos === null) return null;

  const node = view.state.doc.nodeAt(pos);
  if (!node || node.type.name !== "wikilink") return null;

  const target = (node.attrs.target as string) ?? "";
  const alias = (node.attrs.alias as string | null) ?? null;

  return {
    id: `wikilink:${pos}`,
    title: "Edit Wikilink",
    rect: anchor.getBoundingClientRect(),
    width: 360,
    pos,
    fields: [
      {
        key: "target",
        label: "Target",
        value: target,
        suggest: (query: string) => {
          const items = flattenMarkdownFiles(vaultState.files);
          return filterWikilinkSuggestions(items, query, getActiveFilePath?.() ?? undefined)
            .slice(0, 20)
            .map((item) => ({
              label: item.name,
              value: item.path,
              description: item.folder || undefined,
            }));
        },
      },
      { key: "alias", label: "Alias", value: alias ?? "", placeholder: "Optional" },
    ],
  };
}

function resolveSelectionWikilinkAnchor(view: EditorView): HTMLAnchorElement | null {
  const selectionAnchor = view.dom.ownerDocument.getSelection()?.focusNode;
  let focusAnchor: Element | null = null;

  if (selectionAnchor?.nodeType === Node.TEXT_NODE) {
    focusAnchor = selectionAnchor.parentElement?.closest("a[data-wikilink]") ?? null;
  } else if (selectionAnchor instanceof Element) {
    focusAnchor = selectionAnchor.closest("a[data-wikilink]");
  }

  if (isEditorAnchor(view, focusAnchor)) {
    return focusAnchor;
  }

  const selection = view.state.selection;
  if (selection instanceof NodeSelection && selection.node.type.name === "wikilink") {
    const nodeDom = view.nodeDOM(selection.from);
    return nodeDom instanceof HTMLAnchorElement ? nodeDom : null;
  }

  return null;
}

function moveSelectionAwayFromWikilink(target: WikilinkAnchorEditTarget, view: EditorView): void {
  const node = view.state.doc.nodeAt(target.pos);
  if (!node) return;

  const after = Math.min(target.pos + node.nodeSize, view.state.doc.content.size);
  const before = Math.max(target.pos, 0);

  try {
    const tr = view.state.tr.setSelection(Selection.near(view.state.tr.doc.resolve(after), 1));
    view.dispatch(tr);
    return;
  } catch {
    // Try the other side when there is no valid text selection after the node.
  }

  try {
    const tr = view.state.tr.setSelection(Selection.near(view.state.tr.doc.resolve(before), -1));
    view.dispatch(tr);
  } catch {
    // Ignore invalid cursor recovery and keep the existing selection.
  }
}

function applyWikilinkAnchorEdit(
  target: WikilinkAnchorEditTarget,
  values: AnchorEditValues,
  view: EditorView,
): { close: true } | undefined {
  const nextTarget = values.target?.trim() ?? "";
  if (!nextTarget) return undefined;

  const nextAlias = values.alias?.trim() ?? "";
  const tr = view.state.tr.setNodeMarkup(target.pos, undefined, {
    target: nextTarget,
    alias: nextAlias.length > 0 ? nextAlias : null,
  });
  view.dispatch(tr);

  return { close: true };
}

export function registerWikilinkAnchorEditHandler(getActiveFilePath?: () => string | null) {
  return registerAnchorEditHandler({
    selector: "a[data-wikilink]",
    resolveFromAnchor(anchor, view) {
      return createWikilinkAnchorEditTarget(anchor, view, getActiveFilePath);
    },
    resolveFromSelection(view) {
      const anchor = resolveSelectionWikilinkAnchor(view);
      return anchor ? createWikilinkAnchorEditTarget(anchor, view, getActiveFilePath) : null;
    },
    apply: applyWikilinkAnchorEdit,
    close(target, view) {
      moveSelectionAwayFromWikilink(target, view);
    },
  });
}
