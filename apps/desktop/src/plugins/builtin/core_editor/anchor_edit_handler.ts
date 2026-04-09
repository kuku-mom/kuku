import type { EditorView } from "prosekit/pm/view";

import {
  registerAnchorEditHandler,
  type AnchorEditTarget,
  type AnchorEditValues,
} from "~/plugins/anchor_editors";

interface LinkAnchorEditTarget extends AnchorEditTarget {
  from: number;
  to: number;
}

function isEditorAnchor(view: EditorView, value: EventTarget | null): value is HTMLAnchorElement {
  return value instanceof HTMLAnchorElement && view.dom.contains(value);
}

function resolveLinkMarkRange(
  anchor: HTMLAnchorElement,
  view: EditorView,
): { from: number; to: number } | null {
  const range = document.createRange();
  range.selectNodeContents(anchor);

  try {
    const from = view.posAtDOM(range.startContainer, range.startOffset);
    const to = view.posAtDOM(range.endContainer, range.endOffset);
    return from < to ? { from, to } : null;
  } catch {
    return null;
  }
}

function createLinkAnchorEditTarget(
  anchor: HTMLAnchorElement,
  view: EditorView,
): LinkAnchorEditTarget | null {
  const href = anchor.getAttribute("href")?.trim();
  if (!href) return null;

  const range = resolveLinkMarkRange(anchor, view);
  if (!range) return null;

  return {
    id: `link:${range.from}:${range.to}`,
    title: "Edit Link",
    rect: anchor.getBoundingClientRect(),
    width: 320,
    from: range.from,
    to: range.to,
    fields: [
      {
        key: "href",
        label: "URL",
        value: href,
        placeholder: "https://example.com",
      },
    ],
  };
}

function resolveSelectionLinkAnchor(view: EditorView): HTMLAnchorElement | null {
  const selectionAnchor = view.dom.ownerDocument.getSelection()?.focusNode;
  let focusAnchor: Element | null = null;

  if (selectionAnchor?.nodeType === Node.TEXT_NODE) {
    focusAnchor = selectionAnchor.parentElement?.closest("a[href]") ?? null;
  } else if (selectionAnchor instanceof Element) {
    focusAnchor = selectionAnchor.closest("a[href]");
  }

  return isEditorAnchor(view, focusAnchor) ? focusAnchor : null;
}

function findExistingLinkAttrs(
  from: number,
  to: number,
  view: EditorView,
): Record<string, unknown> {
  const linkMark = view.state.schema.marks.link;
  if (!linkMark) return {};

  let attrs: Record<string, unknown> | null = null;
  view.state.doc.nodesBetween(from, to, (node) => {
    const mark = node.marks.find((candidate) => candidate.type === linkMark);
    if (!mark) return undefined;
    attrs = { ...mark.attrs };
    return false;
  });

  return attrs ?? {};
}

function applyLinkAnchorEdit(
  target: LinkAnchorEditTarget,
  values: AnchorEditValues,
  view: EditorView,
) {
  const linkMark = view.state.schema.marks.link;
  if (!linkMark) {
    return { close: true } satisfies { close: boolean };
  }

  const href = values.href?.trim() ?? "";
  const existingAttrs = findExistingLinkAttrs(target.from, target.to, view);
  const tr = view.state.tr.removeMark(target.from, target.to, linkMark);

  if (href.length > 0) {
    tr.addMark(target.from, target.to, linkMark.create({ ...existingAttrs, href }));
  }

  view.dispatch(tr);

  if (href.length === 0) {
    return { close: true, focusEditor: false };
  }

  return {};
}

export function registerLinkAnchorEditHandler() {
  return registerAnchorEditHandler({
    selector: "a[href]",
    resolveFromAnchor(anchor, view) {
      return createLinkAnchorEditTarget(anchor, view);
    },
    resolveFromSelection(view) {
      const anchor = resolveSelectionLinkAnchor(view);
      return anchor ? createLinkAnchorEditTarget(anchor, view) : null;
    },
    apply: applyLinkAnchorEdit,
  });
}
