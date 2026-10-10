// ── List Node ──
//
// Defines the "list" node using prosemirror-flat-list for flat list structure.
// Supports bullet, ordered, and task lists with indent/dedent/split
// plus clipboard serialization normalization.
//
// Vendored from ProseKit predefined extension with customizations.

import {
  defineCommands,
  defineClipboardSerializer,
  defineKeymap,
  defineNodeSpec,
  definePlugin,
  insertNode,
  union,
  type Extension,
} from "prosekit/core";
import { defineInputRule } from "prosekit/extensions/input-rule";
import { chainCommands, deleteSelection } from "prosekit/pm/commands";
import { InputRule } from "prosekit/pm/inputrules";
import { Fragment, Slice, type Node as ProseMirrorNode } from "prosekit/pm/model";
import { Plugin, type EditorState, type Transaction } from "prosekit/pm/state";
import { Mapping } from "prosekit/pm/transform";
import type { EditorView } from "prosekit/pm/view";
import {
  createDedentListCommand,
  createIndentListCommand,
  createListSpec,
  createMoveListCommand,
  createSplitListCommand,
  createToggleListCommand,
  createUnwrapListCommand,
  createWrapInListCommand,
  deleteCommand,
  enterCommand,
  joinListUp,
  listInputRules,
  listToDOM,
  unwrapListSlice,
  createListRenderingPlugin,
  createSafariInputMethodWorkaroundPlugin,
  joinListElements,
} from "prosemirror-flat-list";
import { parseTaskMetadata, type TaskMetadata } from "~/lib/planner_tasks";

/**
 * Internal InputRule fields that are present at runtime but not exposed
 * in the public type declarations (`@internal` in prosemirror-inputrules).
 */
interface InputRuleInternal {
  match: RegExp;
  handler: (
    state: EditorState,
    match: RegExpMatchArray,
    start: number,
    end: number,
  ) => Transaction | null;
  undoable: boolean;
  inCodeMark: boolean;
}

const TOGGLE_LIST_INPUT_RULE_PATTERN = /^\s?>>\s$/;

function shouldAutoWrapListInputRule(rule: InputRule): InputRule {
  const internal = rule as unknown as InputRuleInternal;
  return new InputRule(
    internal.match,
    (state, match, start, end) => {
      if (state.selection.$from.parent.type.name !== "paragraph") {
        return null;
      }

      return internal.handler(state, match, start, end);
    },
    {
      undoable: internal.undoable,
      inCode: rule.inCode,
      inCodeMark: internal.inCodeMark,
    },
  );
}

function isToggleListInputRule(rule: InputRule): boolean {
  const internal = rule as unknown as InputRuleInternal;
  return internal.match.source === TOGGLE_LIST_INPUT_RULE_PATTERN.source;
}

function defineListSerializer() {
  return defineClipboardSerializer({
    serializeFragmentWrapper: (fn) => {
      const wrapped: typeof fn = (fragment, options, target) => {
        const dom = fn(fragment, options, target);
        return normalizeElementTree(
          joinListElements(dom as Element | DocumentFragment),
        ) as typeof dom;
      };
      return wrapped;
    },
    serializeNodeWrapper: (fn) => {
      const wrapped: typeof fn = (node, options) => {
        const dom = fn(node, options);
        return isElementLike(dom)
          ? (normalizeElementTree(
              joinListElements(dom as Element | DocumentFragment),
            ) as typeof dom)
          : dom;
      };
      return wrapped;
    },
    nodesFromSchemaWrapper: (fn) => {
      const wrapped: typeof fn = (schema) => {
        const nodes = fn(schema);
        return {
          ...nodes,
          list: (node: ProseMirrorNode) =>
            listToDOM({ node, nativeList: true, getAttributes: getListAttributes }),
        };
      };
      return wrapped;
    },
  });
}

function normalizeElementTree(node: Element | DocumentFragment): Element | DocumentFragment {
  if (isElementLike(node)) {
    normalizeTaskList(node);
  }

  for (const child of node.children) {
    normalizeElementTree(child);
  }

  return node;
}

function normalizeTaskList(node: Element): void {
  if (
    !node.classList.contains("prosemirror-flat-list") ||
    node.getAttribute("data-list-kind") !== "task" ||
    node.children.length !== 2
  ) {
    return;
  }

  const marker = node.children.item(0);
  if (!marker || !marker.classList.contains("list-marker")) {
    return;
  }

  const content = node.children.item(1);
  if (!content || !content.classList.contains("list-content")) {
    return;
  }

  const checkbox = marker.querySelector('input[type="checkbox"]');
  if (!checkbox) {
    return;
  }

  const textBlock = content.children.item(0);
  if (!textBlock || !["P", "H1", "H2", "H3", "H4", "H5", "H6"].includes(textBlock.tagName)) {
    return;
  }

  node.replaceChildren(...content.children);
  textBlock.prepend(checkbox);
}

function isElementLike(node: Node): node is Element {
  return node instanceof Element;
}

// ── Attributes (vendored from prosemirror-flat-list@0.5.8 defaultAttributesGetter) ──
//
// Vendored so we can add `user-select: none` and `draggable: false` directly
// to the list wrapper div. Without this, ::selection paints full-width
// backgrounds on block-level list wrappers in nested/indented lists.

interface ListAttrs {
  kind?: string;
  order?: number | null;
  checked?: boolean;
  taskMetadata?: TaskMetadata | null;
}

function getListMarkerClickAttrs(attrs: ListAttrs): ListAttrs {
  if (attrs.kind === "task") {
    return { ...attrs, checked: !attrs.checked };
  }

  return attrs;
}

function setNodeAttributes(
  tr: Transaction,
  pos: number,
  previousAttrs: ListAttrs,
  nextAttrs: ListAttrs,
): boolean {
  let changed = false;

  for (const key of Object.keys(nextAttrs) as (keyof ListAttrs)[]) {
    if (nextAttrs[key] === previousAttrs[key]) {
      continue;
    }

    tr.setNodeAttribute(pos, key, nextAttrs[key]);
    changed = true;
  }

  return changed;
}

function handleListMarkerMouseDown(view: EditorView, event: MouseEvent): boolean {
  const target = event.target;
  if (!(target instanceof HTMLElement) || !target.closest(".list-marker-click-target")) {
    return false;
  }

  event.preventDefault();

  const pos = view.posAtDOM(target, -10, -10);
  const tr = view.state.tr;
  const $pos = tr.doc.resolve(pos);
  const list = $pos.parent;
  if (list.type.name !== "list") {
    return false;
  }

  const listPos = $pos.before($pos.depth);
  const nextAttrs = getListMarkerClickAttrs(list.attrs as ListAttrs);
  if (setNodeAttributes(tr, listPos, list.attrs as ListAttrs, nextAttrs)) {
    view.dispatch(tr);
  }

  return true;
}

function createStandardListEventPlugin(): Plugin {
  return new Plugin({
    props: {
      handleDOMEvents: {
        mousedown: (view, event) =>
          event instanceof MouseEvent ? handleListMarkerMouseDown(view, event) : false,
      },
    },
  });
}

function getListAttributes(node: {
  attrs: Record<string, unknown>;
  childCount: number;
  firstChild?: { type: { name: string } } | null;
}): Record<string, string | undefined> {
  const attrs = node.attrs as ListAttrs;
  const hasNestedFirstChild = node.firstChild?.type.name === "list";
  const kind = attrs.kind === "toggle" ? "bullet" : attrs.kind;
  const markerType = hasNestedFirstChild ? undefined : kind || "bullet";

  return {
    class: "prosemirror-flat-list",
    "data-list-kind": markerType,
    "data-list-order": attrs.order != null ? String(attrs.order) : undefined,
    "data-list-checked": attrs.checked ? "" : undefined,
    "data-kuku-task": attrs.taskMetadata ? JSON.stringify(attrs.taskMetadata) : undefined,
    style: attrs.order != null ? `--prosemirror-flat-list-order: ${attrs.order}` : undefined,
  };
}

// ── Spec ──

function defineListSpec(): Extension {
  const spec = createListSpec();
  return defineNodeSpec({
    ...spec,
    name: "list",
    attrs: { ...spec.attrs, taskMetadata: { default: null } },
    parseDOM: spec.parseDOM?.map((rule) => ({
      ...rule,
      getAttrs(dom: HTMLElement | string) {
        const previous = rule.getAttrs?.(dom as HTMLElement);
        if (previous === false) return false;
        const raw = typeof dom === "string" ? null : dom.getAttribute("data-kuku-task");
        let taskMetadata: TaskMetadata | null = null;
        try {
          taskMetadata = raw ? parseTaskMetadata(JSON.parse(raw)) : null;
        } catch {
          /* Keep ordinary list attributes. */
        }
        return { ...rule.attrs, ...previous, taskMetadata };
      },
    })),
    toDOM: (node) =>
      listToDOM({
        node,
        getAttributes: getListAttributes,
        getMarkers: (n: { attrs: Record<string, unknown> }) => {
          const attrs = n.attrs as { kind?: string; checked?: boolean };
          if (attrs.kind === "task") {
            return [
              [
                "label",
                {
                  class: "kuku-task-checkbox",
                },
                [
                  "input",
                  {
                    type: "checkbox",
                    checked: attrs.checked ? "" : undefined,
                    class: "kuku-task-checkbox__input",
                    "aria-label": "Toggle task",
                  },
                ],
                [
                  "span",
                  {
                    class: "kuku-task-checkbox__control",
                    "aria-hidden": "true",
                  },
                ],
              ],
            ];
          }
          return [];
        },
      }),
  });
}

// ── Commands ──

function defineListCommands(): Extension {
  return defineCommands({
    dedentList: createDedentListCommand,
    indentList: createIndentListCommand,
    moveList: createMoveListCommand,
    splitList: createSplitListCommand,
    unwrapList: createUnwrapListCommand,
    toggleList: createToggleListCommand,
    wrapInList: createWrapInListCommand,
    insertList: (attrs?: Record<string, unknown>) => insertNode({ type: "list", attrs }),
  });
}

// ── Input Rules ──

function defineListInputRules(): Extension {
  return union(
    listInputRules
      .filter((rule) => !isToggleListInputRule(rule))
      .map((rule) => defineInputRule(shouldAutoWrapListInputRule(rule))),
  );
}

// ── Keymap ──

function defineListKeymap(): Extension {
  const backspaceCommand = chainCommands(deleteSelection, joinListUp);
  const dedentListCommand = createDedentListCommand();
  const indentListCommand = createIndentListCommand();

  return defineKeymap({
    Enter: enterCommand,
    Backspace: backspaceCommand,
    Delete: deleteCommand,
    "Mod-]": indentListCommand,
    "Mod-[": dedentListCommand,
    Tab: indentListCommand,
    "Shift-Tab": dedentListCommand,
  });
}

// ── Plugins ──

function defineListPlugins(): Extension {
  return definePlugin(() => [
    createStandardListEventPlugin(),
    createListRenderingPlugin(),
    createTaskIdentityPlugin(),
    new Plugin({ props: { transformCopied: unwrapListSlice } }),
    createSafariInputMethodWorkaroundPlugin(),
  ]);
}

/** Copying creates tasks; moving and undoing retain the original identity. */
export function createTaskIdentityPlugin(): Plugin {
  function copiedFragment(fragment: Fragment): Fragment {
    const children: ProseMirrorNode[] = [];
    fragment.forEach((node) => {
      if (node.isText) {
        children.push(node);
        return;
      }
      const metadata = parseTaskMetadata(node.attrs.taskMetadata);
      let attrs = node.attrs;
      if (metadata) {
        const copiedMetadata = { ...metadata, id: crypto.randomUUID() };
        delete copiedMetadata.timeBlockLinkId;
        attrs = { ...node.attrs, taskMetadata: copiedMetadata };
      }
      children.push(node.type.create(attrs, copiedFragment(node.content), node.marks));
    });
    return Fragment.fromArray(children);
  }
  return new Plugin({
    props: {
      transformPasted: (slice, view) =>
        // ProseMirror also calls this hook for internal drag moves. Defer
        // internal drag copies to duplicate repair so moves keep their IDs.
        view?.dragging
          ? slice
          : new Slice(copiedFragment(slice.content), slice.openStart, slice.openEnd),
    },
    appendTransaction(transactions, previous, next) {
      if (!transactions.some((transaction) => transaction.docChanged)) return null;
      const existing = new Map<string, number>();
      const originalPositions = new Map<string, number>();
      const mapping = new Mapping();
      transactions.forEach((value) => mapping.appendMapping(value.mapping));
      previous.doc.descendants((node, position) => {
        const metadata = parseTaskMetadata(node.attrs.taskMetadata);
        if (metadata) {
          existing.set(metadata.id, (existing.get(metadata.id) ?? 0) + 1);
          originalPositions.set(metadata.id, mapping.map(position));
        }
      });
      const positions = new Map<string, number[]>();
      next.doc.descendants((node, position) => {
        const metadata = parseTaskMetadata(node.attrs.taskMetadata);
        if (metadata) positions.set(metadata.id, [...(positions.get(metadata.id) ?? []), position]);
      });
      let transaction: Transaction | null = null;
      next.doc.descendants((node, position) => {
        const metadata = parseTaskMetadata(node.attrs.taskMetadata);
        if (!metadata) return;
        const matches = positions.get(metadata.id) ?? [];
        const original = originalPositions.get(metadata.id);
        const keep = original !== undefined && matches.includes(original) ? original : matches[0];
        // Only repair duplicates introduced by an edit. Loading an externally
        // duplicated ID remains detectable by the planner, without rewriting notes.
        if (matches.length > 1 && position !== keep && existing.get(metadata.id) === 1) {
          transaction ??= next.tr;
          transaction.setNodeMarkup(position, undefined, {
            ...node.attrs,
            taskMetadata: { id: crypto.randomUUID() },
          });
        }
      });
      return transaction;
    },
  });
}

// ── Composed ──

function defineList(): Extension {
  return union(
    defineListSpec(),
    defineListCommands(),
    defineListInputRules(),
    defineListKeymap(),
    defineListPlugins(),
    defineListSerializer(),
  );
}

export { defineList, getListMarkerClickAttrs, isToggleListInputRule, shouldAutoWrapListInputRule };
