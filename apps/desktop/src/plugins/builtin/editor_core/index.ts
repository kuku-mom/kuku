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

import { union, type Extension } from "prosekit/core";
import { defineHardBreak } from "prosekit/extensions/hard-break";

import { getContextKey } from "~/plugins/context_keys";
import type { KukuPlugin } from "~/plugins/types";

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
import { defineTable } from "./nodes/table";

// ── Extension Factory ──

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
  );
}

// ── Plugin Definition ──

const editorCorePlugin: KukuPlugin = {
  id: "editor-core",
  name: "Editor Core",
  version: "0.1.1",
  description:
    "Base editor extensions: bold, italic, code, strike, link, headings, horizontal rule, blockquote, code block, image, list, table, blank-line preservation (::br directive)",

  // ── Editor Contribution ──
  editor: {
    extension: defineEditorCoreExtension,
    markdown: editorCoreMarkdown,
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
