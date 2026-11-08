import type { Editor } from "prosekit/core";
import type { EditorView } from "prosekit/pm/view";

import { t } from "~/i18n";
import { parseMarkdownLinkLikeSyntax } from "./markdown_input";

type Disposer = () => void;
type EditorListKind = "bullet" | "ordered" | "task";
type EditorSlashSubItemKind = "action" | "url-input" | "dropzone";

type EditorCommand = ((...args: unknown[]) => unknown) & {
  canExec?(...args: unknown[]): boolean;
};

interface EditorSlashItemState {
  blockType: string;
  headingLevel: number;
  listKind: EditorListKind | null;
  insideBlockquote: boolean;
}

interface EditorSlashSubItem {
  id: string;
  title: string;
  description?: string;
  hint?: string;
  kind?: EditorSlashSubItemKind;
  placeholder?: string;
  execute?: (editor: Editor) => void | Promise<void>;
  onSubmitUrl?: (editor: Editor, url: string) => void | Promise<void>;
  onDropFiles?: (editor: Editor, files: FileList | File[]) => void | Promise<void>;
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
  submenu?: readonly EditorSlashSubItem[];
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

const IMAGE_EXTENSION_PATTERN = /\.(?:png|jpe?g|gif|webp|svg|avif|bmp|ico)$/i;

function isLikelyImageFile(file: File): boolean {
  return file.type.startsWith("image/") || IMAGE_EXTENSION_PATTERN.test(file.name);
}

function readBlobAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
      } else {
        reject(new Error("Failed to read image data"));
      }
    };
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read image data"));
    reader.readAsDataURL(blob);
  });
}

function insertImageBySrc(editor: Editor, rawSrc: string, alt?: string): boolean {
  const src = rawSrc.trim();
  if (!src) return false;
  return invokeEditorCommand(getEditorCommands(editor), "insertImage", {
    src,
    ...(alt ? { alt } : {}),
  });
}

async function insertImageFiles(editor: Editor, files: FileList | File[]): Promise<void> {
  const fileList = Array.from(files).filter(isLikelyImageFile);
  for (const file of fileList) {
    try {
      const dataUrl = await readBlobAsDataUrl(file);
      const alt = file.name.replace(/\.[^/.]+$/, "") || undefined;
      insertImageBySrc(editor, dataUrl, alt);
    } catch {
      // Ignore unreadable individual files
    }
  }
}

interface PickedImagePayload {
  src: string;
  alt?: string | null;
}

function tryInsertImageTextPayload(editor: Editor, rawText: string, defaultAlt?: string): boolean {
  const text = rawText.trim();
  if (!text) return false;

  const parsedMarkdownImage = parseMarkdownLinkLikeSyntax(text, {
    image: true,
    allowEmptyLabel: true,
  });
  if (parsedMarkdownImage) {
    return insertImageBySrc(
      editor,
      parsedMarkdownImage.target,
      parsedMarkdownImage.label || defaultAlt || undefined,
    );
  }

  if (/^(?:https?:\/\/|data:image\/)/i.test(text) && !/\s/.test(text)) {
    return insertImageBySrc(editor, text, defaultAlt);
  }

  return false;
}

async function selectImageFileAndInsert(editor: Editor): Promise<void> {
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const picked = await invoke<PickedImagePayload[]>("vault_pick_images");
      for (const item of picked) {
        insertImageBySrc(editor, item.src, item.alt ?? undefined);
      }
      return;
    } catch {
      // Fall back to DOM file input below
    }
  }

  return new Promise((resolve) => {
    if (typeof document === "undefined") {
      resolve();
      return;
    }

    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".png,.jpg,.jpeg,.gif,.webp,.svg,.avif,.bmp,.ico,image/png,image/jpeg,image/gif,image/webp,image/svg+xml,image/avif,image/bmp,image/x-icon";
    input.multiple = true;
    input.style.display = "none";
    document.body.appendChild(input);

    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      input.remove();
      resolve();
    };

    input.addEventListener("change", () => {
      const selected = input.files;
      if (selected && selected.length > 0) {
        void insertImageFiles(editor, selected).finally(cleanup);
      } else {
        cleanup();
      }
    });

    input.addEventListener("cancel", cleanup);
    input.click();
  });
}

async function pasteImageFromClipboard(editor: Editor): Promise<void> {
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const payload = await invoke<PickedImagePayload | null>("vault_read_clipboard_image");
      if (payload?.src) {
        tryInsertImageTextPayload(editor, payload.src, payload.alt ?? undefined);
      }
      return;
    } catch {
      // Fall back to browser clipboard API below
    }
  }

  if (typeof navigator === "undefined" || !navigator.clipboard) return;

  if (typeof navigator.clipboard.read === "function") {
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const imageType = item.types.find((type) => type.startsWith("image/"));
        if (imageType) {
          const blob = await item.getType(imageType);
          const dataUrl = await readBlobAsDataUrl(blob);
          insertImageBySrc(editor, dataUrl);
          return;
        }
      }
    } catch {
      // Fall back to readText below
    }
  }

  if (typeof navigator.clipboard.readText === "function") {
    try {
      const text = await navigator.clipboard.readText();
      tryInsertImageTextPayload(editor, text);
    } catch {
      // Clipboard read denied or unavailable
    }
  }
}

function insertImage(editor: Editor): Promise<void> {
  return selectImageFileAndInsert(editor);
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
      keywords: ["image", "img", "picture", "photo", "media", "bild"],
      group: "insert",
      order: 33,
      execute: insertImage,
      submenu: [
        {
          id: "core-editor.image.select-file",
          title: t("editor.slash.image.select_file.title"),
          description: t("editor.slash.image.select_file.description"),
          hint: "Finder",
          kind: "action",
          execute: selectImageFileAndInsert,
        },
        {
          id: "core-editor.image.clipboard",
          title: t("editor.slash.image.clipboard.title"),
          description: t("editor.slash.image.clipboard.description"),
          hint: "⌘V",
          kind: "action",
          execute: pasteImageFromClipboard,
        },
        {
          id: "core-editor.image.url",
          title: t("editor.slash.image.url.title"),
          description: t("editor.slash.image.url.description"),
          hint: "URL",
          kind: "url-input",
          placeholder: t("editor.slash.image.url.placeholder"),
          onSubmitUrl: (editor, url) => {
            insertImageBySrc(editor, url);
          },
        },
        {
          id: "core-editor.image.dropzone",
          title: t("editor.slash.image.dropzone.title"),
          description: t("editor.slash.image.dropzone.description"),
          hint: "Drop",
          kind: "dropzone",
          execute: selectImageFileAndInsert,
          onDropFiles: insertImageFiles,
        },
      ],
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
  insertImageBySrc,
  insertImageFiles,
  pasteImageFromClipboard,
  readEditorSlashItemState,
  registerDefaultEditorSlashItems,
  registerEditorSlashItem,
  selectImageFileAndInsert,
};
export type {
  EditorSlashItem,
  EditorSlashItemState,
  EditorSlashSubItem,
  EditorSlashSubItemKind,
};
