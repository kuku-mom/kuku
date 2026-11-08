// ── Image Node ──
//
// Defines the "image" node for block-level images with src/alt/width/height attrs.
// Provides schema spec and insert command.
//
// Vendored from ProseKit predefined extension with customizations.
// Upload support is NOT included — will be added separately if needed.

import {
  defineCommands,
  defineNodeSpec,
  definePlugin,
  insertNode,
  union,
  type Extension,
} from "prosekit/core";
import { defineInputRule } from "prosekit/extensions/input-rule";
import { InputRule } from "prosekit/pm/inputrules";
import { Plugin } from "prosekit/pm/state";
import type { EditorView } from "prosekit/pm/view";

import { parseMarkdownLinkLikeSyntax } from "../markdown_input";

function defineImageSpec(): Extension {
  return defineNodeSpec({
    name: "image",
    attrs: {
      src: { default: null },
      alt: { default: null, validate: "string|null" },
      width: { default: null, validate: "number|null" },
      height: { default: null, validate: "number|null" },
    },
    group: "block",
    defining: true,
    draggable: true,
    parseDOM: [
      {
        tag: "img[src]",
        getAttrs: (element) => {
          if (typeof element === "string") return { src: null };
          const rect = element.getBoundingClientRect();
          const imageElement = element instanceof HTMLImageElement ? element : null;
          const width =
            rect.width > 0 ? Math.round(rect.width) : imageElement?.naturalWidth || null;
          const height =
            rect.height > 0 ? Math.round(rect.height) : imageElement?.naturalHeight || null;
          return {
            src: element.getAttribute("src") || null,
            alt: element.getAttribute("alt") || null,
            width,
            height,
          };
        },
      },
    ],
    toDOM(node) {
      const { src, alt, width, height } = node.attrs as {
        src: string | null;
        alt: string | null;
        width: number | null;
        height: number | null;
      };
      return [
        "img",
        {
          src: src ?? undefined,
          alt: alt ?? undefined,
          width: width ?? undefined,
          height: height ?? undefined,
        },
      ];
    },
  });
}

function defineImageCommands(): Extension {
  return defineCommands({
    insertImage: (attrs?: { src: string; alt?: string; width?: number; height?: number }) =>
      insertNode({ type: "image", attrs }),
  });
}

function defineMarkdownImageInputRule(): Extension {
  return defineInputRule(
    new InputRule(/!\[[\s\S]*\)$/, (state, match, start, end) => {
      const parsed = parseMarkdownLinkLikeSyntax(match[0] ?? "", {
        image: true,
        allowEmptyLabel: true,
      });
      if (!parsed) return null;

      const { schema, tr } = state;
      const image = schema.nodes.image.create({
        src: parsed.target,
        alt: parsed.label || null,
        width: null,
        height: null,
      });
      tr.delete(start, end).insert(start - 1, image);
      return tr.scrollIntoView();
    }),
  );
}

const IMAGE_FILE_EXTENSION_PATTERN = /\.(?:png|jpe?g|gif|webp|svg|avif|bmp|ico)$/i;

function extractImageFiles(fileList: FileList | null | undefined): File[] {
  if (!fileList || fileList.length === 0) return [];
  return Array.from(fileList).filter(
    (file) => file.type.startsWith("image/") || IMAGE_FILE_EXTENSION_PATTERN.test(file.name),
  );
}

function readImageFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
      } else {
        reject(new Error("Failed to read image"));
      }
    };
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read image"));
    reader.readAsDataURL(file);
  });
}

async function insertDroppedOrPastedImageFiles(
  view: EditorView,
  files: File[],
  insertPos?: number,
): Promise<void> {
  const imageType = view.state.schema.nodes.image;
  if (!imageType) return;

  for (const file of files) {
    try {
      const src = await readImageFileAsDataUrl(file);
      const alt = file.name.replace(/\.[^/.]+$/, "") || null;
      const node = imageType.create({ src, alt, width: null, height: null });
      const tr = view.state.tr;
      if (typeof insertPos === "number") {
        const clampedPos = Math.max(0, Math.min(insertPos, view.state.doc.content.size));
        tr.insert(clampedPos, node);
      } else {
        tr.replaceSelectionWith(node);
      }
      view.dispatch(tr.scrollIntoView());
    } catch {
      // Ignore unreadable individual image files
    }
  }
}

function extractClipboardImageFiles(data: DataTransfer | null | undefined): File[] {
  if (!data) return [];
  const fromFiles = extractImageFiles(data.files);
  if (fromFiles.length > 0) return fromFiles;

  if (!data.items) return [];
  const items: File[] = [];
  for (let i = 0; i < data.items.length; i += 1) {
    const item = data.items[i];
    if (item && item.kind === "file" && item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) items.push(file);
    }
  }
  return items;
}

function insertImageNodeAtSelection(view: EditorView, src: string, alt?: string | null): void {
  const imageType = view.state.schema.nodes.image;
  if (!imageType) return;
  const node = imageType.create({ src, alt: alt ?? null, width: null, height: null });
  view.dispatch(view.state.tr.replaceSelectionWith(node).scrollIntoView());
}

async function tryPasteNativeClipboardImage(view: EditorView): Promise<void> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const payload = await invoke<{ src: string; alt?: string | null } | null>(
      "vault_read_clipboard_image",
    );
    if (payload?.src && payload.src.startsWith("data:image/")) {
      insertImageNodeAtSelection(view, payload.src, payload.alt);
    }
  } catch {
    // Ignore native clipboard read failure
  }
}

function defineImageDropAndPasteHandler(): Extension {
  return definePlugin(
    new Plugin({
      props: {
        handleDrop(view, event, _slice, moved) {
          if (moved) return false;
          const files = extractImageFiles(event.dataTransfer?.files);
          if (files.length === 0) return false;

          event.preventDefault();
          const coords = { left: event.clientX, top: event.clientY };
          const dropPos = view.posAtCoords(coords)?.pos;
          void insertDroppedOrPastedImageFiles(view, files, dropPos);
          return true;
        },
        handlePaste(view, event) {
          const files = extractClipboardImageFiles(event.clipboardData);
          if (files.length > 0) {
            event.preventDefault();
            void insertDroppedOrPastedImageFiles(view, files);
            return true;
          }

          const plainText = event.clipboardData?.getData("text/plain") ?? "";
          const htmlText = event.clipboardData?.getData("text/html") ?? "";
          if (!plainText && !htmlText) {
            event.preventDefault();
            void tryPasteNativeClipboardImage(view);
            return true;
          }

          return false;
        },
      },
    }),
  );
}

function defineImage(): Extension {
  return union(
    defineImageSpec(),
    defineImageCommands(),
    defineMarkdownImageInputRule(),
    defineImageDropAndPasteHandler(),
  );
}

export { defineImage };
