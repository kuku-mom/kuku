import type { EditorView } from "prosekit/pm/view";

type Disposer = () => void;

interface AnchorEditSuggestItem {
  /** Display text shown in the suggestion list. */
  label: string;
  /** Value inserted into the field when the suggestion is selected. */
  value: string;
  /** Optional secondary text (e.g. folder path). */
  description?: string;
}

interface AnchorEditField {
  key: string;
  label: string;
  value: string;
  placeholder?: string;
  /** Optional suggestion provider. Called with the current input value to produce a list of suggestions. */
  suggest?: (query: string) => AnchorEditSuggestItem[];
}

type AnchorEditValues = Record<string, string>;

interface AnchorEditTarget {
  id: string;
  title: string;
  rect: DOMRect;
  width?: number;
  fields: AnchorEditField[];
}

interface AnchorEditApplyResult {
  close?: boolean;
  focusEditor?: boolean;
}

interface AnchorEditCloseResult {
  focusEditor?: boolean;
}

interface AnchorEditHandler<TTarget extends AnchorEditTarget = AnchorEditTarget> {
  selector: string;
  resolveFromAnchor: (anchor: HTMLAnchorElement, view: EditorView) => TTarget | null;
  resolveFromSelection?: (view: EditorView) => TTarget | null;
  apply: (
    target: TTarget,
    values: AnchorEditValues,
    view: EditorView,
  ) => AnchorEditApplyResult | void;
  close?: (target: TTarget, view: EditorView) => AnchorEditCloseResult | void;
}

interface ResolvedAnchorEditor {
  target: AnchorEditTarget;
  apply: (values: AnchorEditValues, view: EditorView) => AnchorEditApplyResult | void;
  close?: (view: EditorView) => AnchorEditCloseResult | void;
}

interface RegisteredAnchorEditHandler {
  selector: string;
  resolveFromAnchor: (anchor: HTMLAnchorElement, view: EditorView) => AnchorEditTarget | null;
  resolveFromSelection?: (view: EditorView) => AnchorEditTarget | null;
  apply: (
    target: AnchorEditTarget,
    values: AnchorEditValues,
    view: EditorView,
  ) => AnchorEditApplyResult | void;
  close?: (target: AnchorEditTarget, view: EditorView) => AnchorEditCloseResult | void;
}

const handlers: RegisteredAnchorEditHandler[] = [];

function bindResolvedAnchorEditor<TTarget extends AnchorEditTarget>(
  handler: AnchorEditHandler<TTarget>,
  target: TTarget,
): ResolvedAnchorEditor {
  return {
    target,
    apply: (values, view) => handler.apply(target, values, view),
    close: handler.close ? (view) => handler.close?.(target, view) : undefined,
  };
}

export function registerAnchorEditHandler<TTarget extends AnchorEditTarget>(
  handler: AnchorEditHandler<TTarget>,
): Disposer {
  const registeredHandler: RegisteredAnchorEditHandler = {
    selector: handler.selector,
    resolveFromAnchor: (anchor, view) => handler.resolveFromAnchor(anchor, view),
    resolveFromSelection: handler.resolveFromSelection
      ? (view) => handler.resolveFromSelection?.(view) ?? null
      : undefined,
    apply: (target, values, view) => handler.apply(target as TTarget, values, view),
    close: handler.close ? (target, view) => handler.close?.(target as TTarget, view) : undefined,
  };
  handlers.push(registeredHandler);

  return () => {
    const idx = handlers.indexOf(registeredHandler);
    if (idx !== -1) handlers.splice(idx, 1);
  };
}

export function dispatchAnchorEditResolveFromAnchor(
  anchor: HTMLAnchorElement,
  view: EditorView,
): ResolvedAnchorEditor | null {
  for (let i = handlers.length - 1; i >= 0; i -= 1) {
    const handler = handlers[i];
    if (!handler || !anchor.matches(handler.selector)) {
      continue;
    }

    const target = handler.resolveFromAnchor(anchor, view);
    if (target) {
      return bindResolvedAnchorEditor(handler, target);
    }
  }

  return null;
}

export function dispatchAnchorEditResolveFromSelection(
  view: EditorView,
): ResolvedAnchorEditor | null {
  for (let i = handlers.length - 1; i >= 0; i -= 1) {
    const handler = handlers[i];
    if (!handler?.resolveFromSelection) {
      continue;
    }

    const target = handler.resolveFromSelection(view);
    if (target) {
      return bindResolvedAnchorEditor(handler, target);
    }
  }

  return null;
}

export type {
  AnchorEditApplyResult,
  AnchorEditCloseResult,
  AnchorEditField,
  AnchorEditHandler,
  AnchorEditSuggestItem,
  AnchorEditTarget,
  AnchorEditValues,
  ResolvedAnchorEditor,
};
