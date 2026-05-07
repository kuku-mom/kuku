// ── Editor Engine ──
//
// ProseKit custom wrapper for the Kuku editor.
//
// Responsibilities:
//   1. Define the base extension (doc, text, paragraph, history, base keymap)
//   2. Create/destroy the editor instance
//   3. Dynamic plugin extension injection/removal via editor.use()
//   4. Wire into the command system (setEditorProvider)
//   5. Provide node view extension builder for plugin-contributed SolidJS node views
//
// Design: v1.3 §6.3
//
// The base extension provides the minimum viable editor — structural nodes
// (doc, text, paragraph), undo/redo (history), and structural keymaps
// (Enter, Backspace, Tab, etc.). All feature extensions (marks, custom nodes,
// input rules) come from plugins via usePluginExtension().

import {
  createEditor,
  defineBaseKeymap,
  defineHistory,
  union,
  type Editor,
  type Extension,
} from "prosekit/core";
import { defineDoc } from "prosekit/extensions/doc";
import { defineParagraph } from "prosekit/extensions/paragraph";
import { defineText } from "prosekit/extensions/text";

import { setEditorProvider } from "~/plugins/commands";
import type { Disposer, NodeViewContribution } from "~/plugins/types";
import { defineBlurSelection } from "~/components/editor/system/blur_selection";

// ── Module State ──

/** The currently active editor instance. Null when no editor is mounted. */
let activeEditor: Editor | null = null;

/** Plugin ID → disposer that removes the plugin's extension from the editor. */
const pluginExtensions = new Map<string, Disposer>();

/** Extensions registered before the editor was created. Applied on createKukuEditor(). */
const pendingExtensions = new Map<string, Extension>();

// ── Base Extension ──

/**
 * Minimum viable extension for a working editor.
 *
 * Includes the bare minimum schema nodes (predefined from prosekit) so the
 * editor can always initialize with a valid schema, even before plugins load:
 * - `defineDoc()` — root document node (content: "block+")
 * - `defineText()` — inline text leaf node (group: "inline")
 * - `defineParagraph()` — default block node (content: "inline*", group: "block")
 * - `defineHistory()` — undo/redo (Mod-Z / Mod-Shift-Z)
 * - `defineBaseKeymap()` — structural keys (Enter, Backspace, Delete, Tab, etc.)
 *
 * Feature extensions (marks, custom nodes, input rules) are added
 * dynamically by plugins via usePluginExtension() / pendingExtensions.
 */
function defineBaseExtension(): Extension {
  return union(
    defineDoc(),
    defineText(),
    defineParagraph(),
    defineHistory(),
    defineBaseKeymap(),
    defineBlurSelection(),
  );
}

// ── Editor Lifecycle ──

/**
 * Create a new editor instance with the base extension.
 *
 * Optionally accepts an additional extension to compose with the base
 * (e.g. for extensions that must be present at creation time).
 *
 * Wires the editor into the command system so that `editorExecute`
 * commands can access the editor via `getActiveEditor()`.
 *
 * @returns The created ProseKit Editor instance.
 *          Mount it to the DOM with `<div ref={editor.mount} />`.
 */
function createKukuEditor(additionalExtension?: Extension): Editor {
  // If an editor already exists, destroy it first
  if (activeEditor) {
    destroyEditor();
  }

  // Compose ALL extensions into a single extension for createEditor().
  // ProseKit requires all schema-defining specs (NodeSpec, MarkSpec) to be
  // present at creation time — editor.use() cannot add them after.
  // Pending extensions from plugins activated before the editor mounted
  // are included here alongside the base extension.
  const parts: Extension[] = [defineBaseExtension()];

  for (const ext of pendingExtensions.values()) {
    parts.push(ext);
  }

  if (additionalExtension) {
    parts.push(additionalExtension);
  }

  const extension = parts.length === 1 ? parts[0] : union(...parts);

  activeEditor = createEditor({ extension });

  // Wire into command system so editorExecute commands work
  setEditorProvider(() => activeEditor);

  // Mark pending extensions as "baked in" — they are part of the initial
  // schema and cannot be individually removed without recreating the editor.
  for (const pluginId of pendingExtensions.keys()) {
    pluginExtensions.set(pluginId, () => {});
  }

  return activeEditor;
}

/**
 * Destroy the active editor and clean up all plugin extensions.
 *
 * Call when the editor component unmounts (e.g. user navigates away from
 * the editor view).
 */
function destroyEditor(): void {
  // Remove all plugin extensions
  for (const unuse of pluginExtensions.values()) {
    try {
      unuse();
    } catch {
      // Swallow errors during cleanup
    }
  }
  pluginExtensions.clear();

  activeEditor = null;

  // Disconnect from command system
  setEditorProvider(() => null);
}

// ── Plugin Extension Management ──

/**
 * Inject a plugin's extension into the active editor.
 *
 * Uses ProseKit's `editor.use()` for runtime extension composition.
 * If the plugin already has an extension registered, it is replaced.
 *
 * Returns a disposer that removes the extension. The disposer is typically
 * tracked by PluginContext for automatic cleanup on plugin deactivation.
 *
 * @param pluginId — the plugin's unique ID (for tracking)
 * @param extension — the ProseKit Extension to inject
 */
function usePluginExtension(pluginId: string, extension: Extension): Disposer {
  pendingExtensions.set(pluginId, extension);

  if (!activeEditor) {
    return () => {
      pendingExtensions.delete(pluginId);
    };
  }

  // Remove existing extension for this plugin (if re-registering)
  const existing = pluginExtensions.get(pluginId);
  if (existing) {
    try {
      existing();
    } catch {
      // Swallow
    }
  }

  // Inject into the live editor
  const unuse = activeEditor.use(extension);
  pluginExtensions.set(pluginId, unuse);

  return () => {
    unuse();
    pluginExtensions.delete(pluginId);
    pendingExtensions.delete(pluginId);
  };
}

// ── Node View Builder ──

/**
 * Build a ProseKit Extension from a map of plugin-contributed SolidJS node views.
 *
 * Converts `NodeViewContribution` objects into `defineSolidNodeView()` calls
 * and composes them into a single extension via `union()`.
 *
 * Lazily imports `prosekit/solid` to avoid pulling in the SolidJS adapter
 * until it's actually needed.
 *
 * @param nodeViews — map of node name → NodeViewContribution
 * @returns A composed Extension, or null if the map is empty
 */
async function buildNodeViewExtension(
  nodeViews: Record<string, NodeViewContribution>,
): Promise<Extension | null> {
  const entries = Object.entries(nodeViews);
  if (entries.length === 0) return null;

  // Dynamic import to avoid bundling prosekit/solid when no node views are used
  const { defineSolidNodeView } = await import("prosekit/solid");

  const extensions: Extension[] = entries.map(([name, config]) =>
    defineSolidNodeView({
      name,
      component: config.component as never,
      as: config.as,
      contentAs: config.contentAs,
      stopEvent: config.stopEvent,
      ignoreMutation: config.ignoreMutation,
    }),
  );

  return extensions.length === 1 ? extensions[0] : union(...extensions);
}

// ── Getter ──

/**
 * Get the currently active editor instance.
 * Returns null if no editor is mounted.
 *
 * Used by:
 * - PluginContext.editor.instance
 * - Command system (via setEditorProvider)
 * - Editor-contributed convenience getters (hasSelection, getTextContent, etc.)
 */
function getActiveEditorInstance(): Editor | null {
  return activeEditor;
}

// ── Exports ──

export {
  buildNodeViewExtension,
  createKukuEditor,
  destroyEditor,
  getActiveEditorInstance,
  usePluginExtension,
};
