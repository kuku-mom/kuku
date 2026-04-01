// ── List Node ──
//
// Defines the "list" node using prosemirror-flat-list for flat list structure.
// Supports bullet, ordered, and task lists with indent/dedent/split/toggle
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
import { Plugin, type EditorState, type Transaction } from "prosekit/pm/state";
import {
  createDedentListCommand,
  createIndentListCommand,
  createListSpec,
  createMoveListCommand,
  createSplitListCommand,
  createToggleCollapsedCommand,
  createToggleListCommand,
  createUnwrapListCommand,
  createWrapInListCommand,
  deleteCommand,
  enterCommand,
  joinCollapsedListBackward,
  joinListUp,
  listInputRules,
  listToDOM,
  protectCollapsed,
  unwrapListSlice,
  createListEventPlugin,
  createListRenderingPlugin,
  createSafariInputMethodWorkaroundPlugin,
  joinListElements,
} from "prosemirror-flat-list";
import type { Node as ProseMirrorNode } from "prosekit/pm/model";

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
          list: (node: ProseMirrorNode) => listToDOM({ node, nativeList: true }),
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

// ── Spec ──

function defineListSpec(): Extension {
  return defineNodeSpec({
    ...createListSpec(),
    name: "list",
    toDOM: (node) =>
      listToDOM({
        node,
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
    toggleCollapsed: createToggleCollapsedCommand,
    unwrapList: createUnwrapListCommand,
    toggleList: createToggleListCommand,
    wrapInList: createWrapInListCommand,
    insertList: (attrs?: Record<string, unknown>) => insertNode({ type: "list", attrs }),
  });
}

// ── Input Rules ──

function defineListInputRules(): Extension {
  return union(listInputRules.map((rule) => defineInputRule(shouldAutoWrapListInputRule(rule))));
}

// ── Keymap ──

function defineListKeymap(): Extension {
  const backspaceCommand = chainCommands(
    protectCollapsed,
    deleteSelection,
    joinListUp,
    joinCollapsedListBackward,
  );
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
    createListEventPlugin(),
    createListRenderingPlugin(),
    new Plugin({ props: { transformCopied: unwrapListSlice } }),
    createSafariInputMethodWorkaroundPlugin(),
  ]);
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

export { defineList, shouldAutoWrapListInputRule };
