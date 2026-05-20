import type { Editor } from "prosekit/core";
import type { EditorView } from "prosekit/pm/view";

import { t } from "~/i18n";

type Disposer = () => void;
type EditorListKind = "bullet" | "ordered" | "task";

type EditorCommand = ((...args: unknown[]) => unknown) & {
  canExec?(...args: unknown[]): boolean;
};

interface EditorSlashItemState {
  blockType: string;
  headingLevel: number;
  listKind: EditorListKind | null;
  insideBlockquote: boolean;
}

interface EditorSlashItem {
  id: string;
  title: string;
  description?: string;
  icon?: string;
  keywords?: string[];
  group?: string;
  order?: number;
  showInContextMenu?: boolean;
  isEnabled?: (state: EditorSlashItemState, editor: Editor) => boolean;
  isActive?: (state: EditorSlashItemState, editor: Editor) => boolean;
  execute: (editor: Editor) => void | Promise<void>;
}

interface RegisteredEditorSlashItem {
  item: EditorSlashItem;
  sequence: number;
}

const registeredSlashItems: RegisteredEditorSlashItem[] = [];

let slashItemSequence = 0;

function getEditorCommands(editor: Editor): Record<string, EditorCommand> {
  return (editor as unknown as { commands: Record<string, EditorCommand> }).commands;
}

function invokeEditorCommand(
  commands: Record<string, EditorCommand>,
  name: string,
  ...args: unknown[]
): boolean {
  const command = commands[name];
  if (!command) return false;
  if (command.canExec && !command.canExec(...args)) {
    return false;
  }
  command(...args);
  return true;
}

function readEditorSlashItemState(view: EditorView): EditorSlashItemState {
  const { $from } = view.state.selection;
  const parent = $from.parent;

  let listKind: EditorListKind | null = null;
  let insideBlockquote = false;

  for (let depth = $from.depth; depth >= 0; depth -= 1) {
    const node = $from.node(depth);
    if (!insideBlockquote && node.type.name === "blockquote") {
      insideBlockquote = true;
    }
    if (listKind === null && node.type.name === "list") {
      listKind = (node.attrs.kind as EditorListKind | undefined) ?? "bullet";
    }
  }

  return {
    blockType: parent.type.name,
    headingLevel: parent.type.name === "heading" ? ((parent.attrs.level as number) ?? 0) : 0,
    listKind,
    insideBlockquote,
  };
}

function turnIntoHeading(editor: Editor, level: number): void {
  invokeEditorCommand(getEditorCommands(editor), "toggleHeading", { level });
}

function turnIntoBlockquote(editor: Editor): void {
  invokeEditorCommand(getEditorCommands(editor), "toggleBlockquote");
}

function turnIntoCodeBlock(editor: Editor): void {
  invokeEditorCommand(getEditorCommands(editor), "toggleCodeBlock");
}

function insertHorizontalRule(editor: Editor): void {
  invokeEditorCommand(getEditorCommands(editor), "insertHorizontalRule");
}

function insertImage(editor: Editor): void {
  const src = window.prompt(t("editor.slash.image.prompt"), "https://")?.trim();
  if (!src) return;
  invokeEditorCommand(getEditorCommands(editor), "insertImage", { src });
}

function insertTable(editor: Editor): void {
  invokeEditorCommand(getEditorCommands(editor), "insertTable", { row: 3, col: 3, header: true });
}

function turnIntoList(editor: Editor, kind: EditorListKind): void {
  const state = readEditorSlashItemState(editor.view);
  if (state.blockType !== "paragraph") return;
  invokeEditorCommand(getEditorCommands(editor), "toggleList", {
    kind,
    ...(kind === "task" ? { checked: false } : {}),
  });
}

function registerEditorSlashItem(item: EditorSlashItem): Disposer {
  const entry: RegisteredEditorSlashItem = {
    item,
    sequence: slashItemSequence++,
  };
  registeredSlashItems.push(entry);

  return () => {
    const idx = registeredSlashItems.indexOf(entry);
    if (idx !== -1) {
      registeredSlashItems.splice(idx, 1);
    }
  };
}

function getEditorSlashItems(): EditorSlashItem[] {
  return [...registeredSlashItems]
    .sort((left, right) => {
      const leftOrder = left.item.order ?? 100;
      const rightOrder = right.item.order ?? 100;
      return leftOrder === rightOrder ? left.sequence - right.sequence : leftOrder - rightOrder;
    })
    .map((entry) => entry.item);
}

function filterEditorSlashItems(query: string): EditorSlashItem[] {
  const normalizedQuery = query.trim().toLowerCase();
  const items = getEditorSlashItems();

  if (!normalizedQuery) {
    return items;
  }

  return items.filter((item) => {
    const haystack = [item.title, item.description ?? "", ...(item.keywords ?? [])]
      .join(" ")
      .toLowerCase();
    return haystack.includes(normalizedQuery);
  });
}

function registerDefaultEditorSlashItems(): Disposer {
  const disposers = [
    registerEditorSlashItem({
      id: "core-editor.heading-1",
      title: t("editor.slash.heading1.title"),
      description: t("editor.slash.heading1.description"),
      icon: "heading1",
      keywords: ["h1", "title"],
      group: "heading",
      order: 20,
      isEnabled: (state) => state.headingLevel !== 1,
      isActive: (state) => state.headingLevel === 1,
      execute: (editor) => turnIntoHeading(editor, 1),
    }),
    registerEditorSlashItem({
      id: "core-editor.heading-2",
      title: t("editor.slash.heading2.title"),
      description: t("editor.slash.heading2.description"),
      icon: "heading2",
      keywords: ["h2", "subtitle"],
      group: "heading",
      order: 21,
      isEnabled: (state) => state.headingLevel !== 2,
      isActive: (state) => state.headingLevel === 2,
      execute: (editor) => turnIntoHeading(editor, 2),
    }),
    registerEditorSlashItem({
      id: "core-editor.heading-3",
      title: t("editor.slash.heading3.title"),
      description: t("editor.slash.heading3.description"),
      icon: "heading3",
      keywords: ["h3"],
      group: "heading",
      order: 22,
      isEnabled: (state) => state.headingLevel !== 3,
      isActive: (state) => state.headingLevel === 3,
      execute: (editor) => turnIntoHeading(editor, 3),
    }),
    registerEditorSlashItem({
      id: "core-editor.blockquote",
      title: t("editor.slash.blockquote.title"),
      description: t("editor.slash.blockquote.description"),
      icon: "blockquote",
      keywords: ["quote", "callout"],
      group: "structure",
      order: 30,
      execute: turnIntoBlockquote,
    }),
    registerEditorSlashItem({
      id: "core-editor.code-block",
      title: t("editor.slash.code_block.title"),
      description: t("editor.slash.code_block.description"),
      icon: "codeBlock",
      keywords: ["code", "snippet", "pre"],
      group: "structure",
      order: 31,
      isEnabled: (state) => state.blockType !== "codeBlock",
      isActive: (state) => state.blockType === "codeBlock",
      execute: turnIntoCodeBlock,
    }),
    registerEditorSlashItem({
      id: "core-editor.horizontal-rule",
      title: t("editor.slash.horizontal_rule.title"),
      description: t("editor.slash.horizontal_rule.description"),
      icon: "horizontalRule",
      keywords: ["hr", "rule", "divider", "separator", "---"],
      group: "insert",
      order: 32,
      execute: insertHorizontalRule,
    }),
    registerEditorSlashItem({
      id: "core-editor.image",
      title: t("editor.slash.image.title"),
      description: t("editor.slash.image.description"),
      icon: "image",
      keywords: ["image", "img", "picture", "photo", "media"],
      group: "insert",
      order: 33,
      execute: insertImage,
    }),
    registerEditorSlashItem({
      id: "core-editor.table",
      title: t("editor.slash.table.title"),
      description: t("editor.slash.table.description"),
      icon: "table",
      keywords: ["table", "grid", "rows", "columns"],
      group: "insert",
      order: 34,
      execute: insertTable,
    }),
    registerEditorSlashItem({
      id: "core-editor.bullet-list",
      title: t("editor.slash.bullet_list.title"),
      description: t("editor.slash.bullet_list.description"),
      icon: "bulletList",
      keywords: ["list", "unordered", "ul"],
      group: "list",
      order: 40,
      isEnabled: (state) => state.listKind !== "bullet" && state.blockType === "paragraph",
      isActive: (state) => state.listKind === "bullet",
      execute: (editor) => turnIntoList(editor, "bullet"),
    }),
    registerEditorSlashItem({
      id: "core-editor.ordered-list",
      title: t("editor.slash.ordered_list.title"),
      description: t("editor.slash.ordered_list.description"),
      icon: "orderedList",
      keywords: ["list", "numbered", "ol"],
      group: "list",
      order: 41,
      isEnabled: (state) => state.listKind !== "ordered" && state.blockType === "paragraph",
      isActive: (state) => state.listKind === "ordered",
      execute: (editor) => turnIntoList(editor, "ordered"),
    }),
    registerEditorSlashItem({
      id: "core-editor.checkbox-list",
      title: t("editor.slash.checkbox_list.title"),
      description: t("editor.slash.checkbox_list.description"),
      icon: "taskList",
      keywords: ["checkbox", "checklist", "task", "todo", "list"],
      group: "list",
      order: 42,
      isEnabled: (state) => state.listKind !== "task" && state.blockType === "paragraph",
      isActive: (state) => state.listKind === "task",
      execute: (editor) => turnIntoList(editor, "task"),
    }),
  ];

  return () => {
    for (let i = disposers.length - 1; i >= 0; i -= 1) {
      disposers[i]?.();
    }
  };
}

export {
  filterEditorSlashItems,
  getEditorSlashItems,
  readEditorSlashItemState,
  registerDefaultEditorSlashItems,
  registerEditorSlashItem,
};
export type { EditorSlashItem, EditorSlashItemState };
