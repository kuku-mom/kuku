// ── Editor Core Plugin ──
//
// Assembles all base editor extensions (marks, nodes) and registers
// their corresponding commands with keybindings into the plugin system.
//
// This plugin provides the foundational editing experience:
//   Marks: bold, italic, code, strike, link
//   Nodes: heading (h1–h6), horizontalRule, blockquote, codeBlock, image, list, table
//
// All extensions use ProseKit core primitives (defineMarkSpec, defineNodeSpec, etc.)
// vendored from ProseKit predefined extensions with customizations.

import { definePlugin, union, type Extension } from "prosekit/core";
import { defineHardBreak } from "prosekit/extensions/hard-break";
import { Plugin } from "prosekit/pm/state";
import type { EditorView } from "prosekit/pm/view";

import { getContextKey } from "~/plugins/context_keys";
import type { KukuPlugin } from "~/plugins/types";

import { registerLinkAnchorEditHandler } from "./anchor_edit_handler";
import { defineBold } from "./marks/bold";
import { defineCode } from "./marks/code";
import { defineItalic } from "./marks/italic";
import { defineLink } from "./marks/link";
import { defineStrike } from "./marks/strike";
import { editorCoreMarkdown } from "./markdown_handlers";
import { defineBlockquote } from "./nodes/blockquote";
import { defineCodeBlock } from "./nodes/code_block";
import { defineHeading } from "./nodes/heading";
import { defineHorizontalRule } from "./nodes/horizontal_rule";
import { defineImage } from "./nodes/image";
import { defineList } from "./nodes/list";
import { registerDefaultEditorSlashItems } from "./slash_items";
import { defineTable } from "./nodes/table";

// ── Extension Factory ──

const SCROLL_MARGIN = 80;
const SCROLL_THRESHOLD = 80;

function findScrollContainer(view: EditorView): HTMLElement | null {
  for (let current = view.dom.parentElement; current; current = current.parentElement) {
    if (current.hasAttribute("data-scroll-area-viewport")) {
      return current;
    }

    const style = getComputedStyle(current);
    const overflowY = style.overflowY;
    const overflowX = style.overflowX;
    const scrollableY =
      (overflowY === "auto" || overflowY === "scroll") &&
      current.scrollHeight > current.clientHeight;
    const scrollableX =
      (overflowX === "auto" || overflowX === "scroll") && current.scrollWidth > current.clientWidth;

    if (scrollableX || scrollableY) {
      return current;
    }
  }

  return null;
}

function getSelectionRect(view: EditorView): DOMRect | null {
  const selection = view.dom.ownerDocument.getSelection();
  if (!selection || selection.rangeCount === 0 || !selection.focusNode) {
    return null;
  }

  const focusHost =
    selection.focusNode.nodeType === Node.TEXT_NODE
      ? selection.focusNode.parentElement
      : (selection.focusNode as HTMLElement | null);

  if (!focusHost || !view.dom.contains(focusHost)) {
    return null;
  }

  const range = selection.getRangeAt(0).cloneRange();
  const rects = range.getClientRects();
  for (const rect of rects) {
    if (rect.width > 0 || rect.height > 0) {
      return rect;
    }
  }

  const rect = range.getBoundingClientRect();
  if (rect.width > 0 || rect.height > 0) {
    return rect;
  }

  return focusHost.getBoundingClientRect();
}

function adjustScrollAxis(params: {
  rectStart: number;
  rectEnd: number;
  boxStart: number;
  boxEnd: number;
  threshold: number;
  margin: number;
}): number {
  const { rectStart, rectEnd, boxStart, boxEnd, threshold, margin } = params;
  if (rectStart < boxStart + threshold) {
    return rectStart - boxStart - margin;
  }
  if (rectEnd > boxEnd - threshold) {
    return rectEnd - boxEnd + margin;
  }
  return 0;
}

function handleEditorScrollToSelection(view: EditorView): boolean {
  const container = findScrollContainer(view);
  const rect = getSelectionRect(view);
  if (!container || !rect) {
    return false;
  }

  const bounds = container.getBoundingClientRect();
  const moveY = adjustScrollAxis({
    rectStart: rect.top,
    rectEnd: rect.bottom,
    boxStart: bounds.top,
    boxEnd: bounds.bottom,
    threshold: SCROLL_THRESHOLD,
    margin: SCROLL_MARGIN,
  });
  const moveX = adjustScrollAxis({
    rectStart: rect.left,
    rectEnd: rect.right,
    boxStart: bounds.left,
    boxEnd: bounds.right,
    threshold: SCROLL_THRESHOLD,
    margin: SCROLL_MARGIN,
  });

  if (moveY !== 0) {
    container.scrollTop += moveY;
  }
  if (moveX !== 0) {
    container.scrollLeft += moveX;
  }

  return true;
}

function handleEditorTextInput(view: EditorView, from: number, to: number, text: string): boolean {
  view.dispatch(view.state.tr.insertText(text, from, to));

  requestAnimationFrame(() => {
    if (view.hasFocus()) {
      handleEditorScrollToSelection(view);
    }
  });

  return true;
}

function defineScrollProps(): Extension {
  return definePlugin(
    new Plugin({
      props: {
        handleTextInput: handleEditorTextInput,
        scrollMargin: SCROLL_MARGIN,
        scrollThreshold: SCROLL_THRESHOLD,
        handleScrollToSelection: handleEditorScrollToSelection,
      },
    }),
  );
}

function defineEditorCoreExtension(): Extension {
  return union(
    // Marks
    defineBold(),
    defineItalic(),
    defineCode(),
    defineStrike(),
    defineLink(),
    defineHardBreak(),

    // Nodes
    defineHeading(),
    defineHorizontalRule(),
    defineBlockquote(),
    defineCodeBlock(),
    defineImage(),
    defineList(),
    defineTable(),

    // Behavior
    defineScrollProps(),
  );
}

// ── Plugin Definition ──

const editorCorePlugin: KukuPlugin = {
  id: "core-editor",
  name: "Editor",
  version: "0.1.1",
  description:
    "Base editor extensions: bold, italic, code, strike, link, headings, horizontal rule, blockquote, code block, image, list, table, blank-line preservation (::br directive)",

  // ── Editor Contribution ──
  editor: {
    extension: defineEditorCoreExtension,
    markdown: editorCoreMarkdown,
  },

  activate(ctx) {
    ctx.track(registerLinkAnchorEditHandler());
    ctx.track(registerDefaultEditorSlashItems());
  },

  // ── Commands ──
  commands: [
    // ── Marks ──

    {
      id: "editor.toggleBold",
      label: "Toggle Bold",
      category: "Editor",
      icon: "bold",
      defaultKeys: ["$mod+KeyB"],
      editorExecute: (editor) => {
        const cmd = (editor as { commands: Record<string, { (): void; canExec(): boolean }> })
          .commands.toggleBold;
        if (!cmd?.canExec()) return false;
        cmd();
        return true;
      },
      when: () => getContextKey("editorTextFocus") === true,
    },
    {
      id: "editor.toggleItalic",
      label: "Toggle Italic",
      category: "Editor",
      icon: "italic",
      defaultKeys: ["$mod+KeyI"],
      editorExecute: (editor) => {
        const cmd = (editor as { commands: Record<string, { (): void; canExec(): boolean }> })
          .commands.toggleItalic;
        if (!cmd?.canExec()) return false;
        cmd();
        return true;
      },
      when: () => getContextKey("editorTextFocus") === true,
    },
    {
      id: "editor.toggleCode",
      label: "Toggle Inline Code",
      category: "Editor",
      icon: "code",
      defaultKeys: ["$mod+KeyE"],
      editorExecute: (editor) => {
        const cmd = (editor as { commands: Record<string, { (): void; canExec(): boolean }> })
          .commands.toggleCode;
        if (!cmd?.canExec()) return false;
        cmd();
        return true;
      },
      when: () => getContextKey("editorTextFocus") === true,
    },

    // ── Headings ──

    {
      id: "editor.toggleHeading1",
      label: "Toggle Heading 1",
      category: "Editor",
      defaultKeys: ["$mod+Alt+Digit1"],
      editorExecute: (editor) => {
        const cmd = (editor as { commands: Record<string, Function> }).commands.toggleHeading;
        if (!cmd) return false;
        cmd({ level: 1 });
        return true;
      },
      when: () => getContextKey("editorTextFocus") === true,
    },
    {
      id: "editor.toggleHeading2",
      label: "Toggle Heading 2",
      category: "Editor",
      defaultKeys: ["$mod+Alt+Digit2"],
      editorExecute: (editor) => {
        const cmd = (editor as { commands: Record<string, Function> }).commands.toggleHeading;
        if (!cmd) return false;
        cmd({ level: 2 });
        return true;
      },
      when: () => getContextKey("editorTextFocus") === true,
    },
    {
      id: "editor.toggleHeading3",
      label: "Toggle Heading 3",
      category: "Editor",
      defaultKeys: ["$mod+Alt+Digit3"],
      editorExecute: (editor) => {
        const cmd = (editor as { commands: Record<string, Function> }).commands.toggleHeading;
        if (!cmd) return false;
        cmd({ level: 3 });
        return true;
      },
      when: () => getContextKey("editorTextFocus") === true,
    },
  ],
};

// ── Exports ──

export { editorCorePlugin };
