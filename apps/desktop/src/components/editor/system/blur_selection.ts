// ── Custom Selection Highlight ──
//
// Replaces the browser's native `::selection` with ProseMirror inline
// decorations so that selection never paints full-width backgrounds on
// block-level wrapper divs (e.g. nested list containers).
//
// Native `::selection` is suppressed via CSS:
//   .ProseMirror ::selection { background: transparent; color: inherit; }
//
// This plugin renders `.pm-selection` decorations that are always present
// (both focused and blurred). The visual difference between focused and
// blurred states is handled purely via a CSS class on the editor DOM
// element — NO transactions are dispatched on focus/blur, which avoids
// scroll-position resets and other side effects.
//
//   Focused:  .ProseMirror.pm-focused .pm-selection  { active color }
//   Blurred:  .ProseMirror:not(.pm-focused) .pm-selection { dim color }
//
// Addressed edge cases:
//   1. rAF timing race — pending blur is cancelled if focus returns first
//   2. Drag-outside blur — mouse-held state suppresses blur class removal
//   3. Stale decorations — selection/doc changes always rebuild decorations
//   4. No dispatch on focus/blur — prevents scroll jumps and reflow issues

import { definePlugin, type Extension } from "prosekit/core";
import type { Node } from "prosekit/pm/model";
import { Plugin, PluginKey } from "prosekit/pm/state";
import { Decoration, DecorationSet } from "prosekit/pm/view";

// ── Constants ──

const pluginKey = new PluginKey<DecorationSet>("selection-highlight");

/** CSS class applied to inline selection decorations. */
const SELECTION_CLASS = "pm-selection";

/**
 * CSS class toggled on the editor DOM element to indicate focus state.
 * Used by CSS to differentiate active vs. preserved selection colors.
 */
const FOCUSED_CLASS = "pm-focused";

/** @deprecated Kept for backward compatibility with existing CSS. */
const BLUR_CLASS = "pm-selection-blur";

// ── Helpers ──

/** Build a decoration set for a non-collapsed selection. */
function buildDecorations(doc: Node, from: number, to: number): DecorationSet {
  if (from === to) return DecorationSet.empty;
  return DecorationSet.create(doc, [Decoration.inline(from, to, { class: SELECTION_CLASS })]);
}

// ── Extension ──

/**
 * Returns a ProseKit Extension that renders custom selection decorations,
 * completely replacing native `::selection` highlighting.
 *
 * Focus/blur is handled by toggling a CSS class on the editor element —
 * no ProseMirror transactions are dispatched, so scroll position and
 * editor state are never disturbed.
 */
function defineBlurSelection(): Extension {
  let pendingBlurRaf: number | null = null;
  let mouseDown = false;

  function cancelPendingBlur(): void {
    if (pendingBlurRaf !== null) {
      cancelAnimationFrame(pendingBlurRaf);
      pendingBlurRaf = null;
    }
  }

  return definePlugin(
    new Plugin<DecorationSet>({
      key: pluginKey,

      state: {
        init(_config, state) {
          const { from, to } = state.selection;
          return buildDecorations(state.doc, from, to);
        },

        apply(tr, prev, _oldState, newState) {
          // Rebuild decorations when selection or document changes.
          if (tr.selectionSet || tr.docChanged) {
            const { from, to } = newState.selection;
            return buildDecorations(newState.doc, from, to);
          }

          return prev;
        },
      },

      props: {
        decorations(state) {
          return pluginKey.getState(state) ?? DecorationSet.empty;
        },

        handleDOMEvents: {
          // ── Track mouse state to suppress drag-blur ──

          mousedown(_view, event: MouseEvent) {
            if (event.button === 0) mouseDown = true;
            return false;
          },

          mouseup(_view, event: MouseEvent) {
            if (event.button === 0) mouseDown = false;
            return false;
          },

          // ── Focus / Blur — CSS class toggle only, no dispatch ──

          focus(view) {
            cancelPendingBlur();
            view.dom.classList.add(FOCUSED_CLASS);
            return false;
          },

          blur(view) {
            // Don't remove focused class during a drag — the user is
            // actively selecting and the editor will regain focus on mouseup.
            if (mouseDown) return false;

            cancelPendingBlur();

            // Delay class removal so the browser finishes processing the
            // focus change. If focus returns before the rAF fires, the
            // pending removal is cancelled (edge case #1).
            pendingBlurRaf = requestAnimationFrame(() => {
              pendingBlurRaf = null;

              if (view.isDestroyed || view.hasFocus() || mouseDown) return;

              view.dom.classList.remove(FOCUSED_CLASS);
            });

            return false;
          },
        },
      },

      view(editorView) {
        // Set initial focus state based on whether the editor has focus.
        if (editorView.hasFocus()) {
          editorView.dom.classList.add(FOCUSED_CLASS);
        }

        return {
          destroy() {
            cancelPendingBlur();
            editorView.dom.classList.remove(FOCUSED_CLASS);
          },
        };
      },
    }),
  );
}

// ── Exports ──

export { defineBlurSelection, BLUR_CLASS, SELECTION_CLASS, FOCUSED_CLASS };
