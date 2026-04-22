// ── Typographic Ligatures ──
//
// ProseMirror plugin that visually replaces common character sequences
// with their Unicode equivalents using Decorations.
//
// The document content is NOT modified — e.g. `->` stays as `->` in
// the markdown file but renders as `→` in the editor.
//
// When the cursor enters a ligature region, the original text is
// revealed for editing. Moving the cursor away re-conceals it.
//
// Ligatures are automatically hidden inside code blocks and inline
// code marks.

import { definePlugin, type Extension } from "prosekit/core";
import { Plugin, PluginKey, type EditorState } from "prosekit/pm/state";
import { Decoration, DecorationSet } from "prosekit/pm/view";

// ── Ligature Definitions ─────────────────────────────────────────────

interface Ligature {
  /** The literal text pattern to match in the document. */
  pattern: string;
  /** The Unicode character to display in its place. */
  replacement: string;
  /** Human-readable name (for settings / debugging). */
  label: string;
}

/**
 * All supported ligatures, ordered by pattern length (longest first).
 * This ensures greedy matching — e.g. `<->` is matched before `<-` or `->`.
 */
const LIGATURES: readonly Ligature[] = [
  // ── 3-char patterns (must come first for greedy matching) ──
  { pattern: "<->", replacement: "↔", label: "Bidirectional arrow" },
  { pattern: "<=>", replacement: "⇔", label: "Bidirectional double arrow" },
  { pattern: "...", replacement: "…", label: "Ellipsis" },

  // ── 2-char patterns ──
  { pattern: "->", replacement: "→", label: "Right arrow" },
  { pattern: "<-", replacement: "←", label: "Left arrow" },
  { pattern: "=>", replacement: "⇒", label: "Double right arrow" },
  { pattern: "--", replacement: "—", label: "Em dash" },
  { pattern: "!=", replacement: "≠", label: "Not equal" },
  { pattern: "<<", replacement: "«", label: "Left guillemet" },
  { pattern: ">>", replacement: "»", label: "Right guillemet" },
];

// ── Decoration Builder ───────────────────────────────────────────────

const pluginKey = new PluginKey<DecorationSet>("typography-ligatures");
const widgetConstructors = new Map<string, () => HTMLSpanElement>();

/**
 * Inline style applied to the original text to visually hide it
 * while keeping DOM nodes intact for ProseMirror's position mapping.
 */
const HIDDEN_STYLE = "font-size:0;overflow:hidden;display:inline-block;width:0;";

function getLigatureWidgetKey({ pattern, replacement }: Ligature): string {
  return `kuku-ligature:${pattern}:${replacement}`;
}

function getLigatureWidgetConstructor({
  pattern,
  replacement,
  label,
}: Ligature): () => HTMLSpanElement {
  const key = getLigatureWidgetKey({ pattern, replacement, label });
  const existing = widgetConstructors.get(key);
  if (existing) {
    return existing;
  }

  const constructor = () => {
    const widget = document.createElement("span");
    widget.className = "kuku-ligature";
    widget.textContent = replacement;
    widget.setAttribute("aria-label", label);
    return widget;
  };

  widgetConstructors.set(key, constructor);
  return constructor;
}

function createLigatureWidgetDecoration(from: number, ligature: Ligature): Decoration {
  return Decoration.widget(from, getLigatureWidgetConstructor(ligature), {
    side: -1,
    key: getLigatureWidgetKey(ligature),
    ignoreSelection: true,
  });
}

function selectionTouchesLigature(
  selection: EditorState["selection"],
  from: number,
  to: number,
): boolean {
  if (selection.empty) {
    return selection.from >= from && selection.from <= to;
  }

  return selection.from <= to && selection.to >= from;
}

/**
 * Scan the document for ligature patterns and build decoration pairs:
 *   1. `Decoration.widget`  — visible replacement glyph
 *   2. `Decoration.inline`  — hides the original text via CSS
 *
 * Skips:
 *   - Code block nodes (`node.type.spec.code`)
 *   - Text with inline code marks
 *   - Ranges where the cursor / selection overlaps (reveals original text)
 */
function buildDecorations(state: EditorState): DecorationSet {
  const { doc, selection } = state;
  const decorations: Decoration[] = [];

  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;

    // Skip text inside code blocks (text nodes are leaves, so the return
    // value itself doesn't matter for descent — we just bail before
    // adding decorations).
    const $pos = doc.resolve(pos);
    if ($pos.parent.type.spec.code) return;

    // Skip text with inline code mark
    if (node.marks.some((m) => m.type.name === "code" || m.type.spec.code)) return;

    const text = node.text;
    let offset = 0;

    while (offset < text.length) {
      let matched = false;

      for (const ligature of LIGATURES) {
        const { pattern } = ligature;
        if (offset + pattern.length > text.length) continue;
        if (!text.startsWith(pattern, offset)) continue;

        const from = pos + offset;
        const to = from + pattern.length;

        // Don't decorate when cursor / selection overlaps this range.
        // This reveals the original text so the user can edit it.
        if (selectionTouchesLigature(selection, from, to)) {
          offset += pattern.length;
          matched = true;
          break;
        }

        // Widget: visible replacement glyph, placed before the hidden text.
        // Use a stable key/constructor so redraws don't churn the DOM.
        decorations.push(createLigatureWidgetDecoration(from, ligature));

        // Inline: hide the original text
        decorations.push(Decoration.inline(from, to, { style: HIDDEN_STYLE }));

        offset += pattern.length;
        matched = true;
        break; // Only one pattern per position
      }

      if (!matched) offset++;
    }
  });

  return DecorationSet.create(doc, decorations);
}

// ── Plugin ───────────────────────────────────────────────────────────

/**
 * Returns a ProseKit Extension that provides typographic ligatures.
 *
 * Uses ProseMirror decorations to visually swap character sequences
 * with Unicode glyphs without modifying the document.
 *
 * Rebuilds decorations when:
 *   - The document changes (new/removed ligature matches)
 *   - The selection changes (reveal/conceal at cursor position)
 */
function defineTypographicLigatures(): Extension {
  return definePlugin(
    new Plugin<DecorationSet>({
      key: pluginKey,

      state: {
        init(_, state) {
          return buildDecorations(state);
        },
        apply(tr, oldDecorations, _oldState, newState) {
          // Rebuild when content changes or selection moves
          if (tr.docChanged || tr.selectionSet) {
            return buildDecorations(newState);
          }
          return oldDecorations;
        },
      },

      props: {
        decorations(state) {
          return pluginKey.getState(state) ?? DecorationSet.empty;
        },
      },
    }),
  );
}

export { defineTypographicLigatures, LIGATURES };
export { createLigatureWidgetDecoration };
export type { Ligature };
