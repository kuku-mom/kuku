// ── Blur Selection ──
//
// ProseMirror plugin that preserves the visual selection highlight when
// the editor loses DOM focus (e.g. when a context menu portal opens).
//
// The browser's native `::selection` pseudo-element is only painted while
// the owning `contenteditable` has focus. This plugin fills the gap by
// applying `Decoration.inline` decorations with a `.pm-selection-blur`
// CSS class over the selection range whenever the editor is blurred.
//
// The decorations are removed immediately when the editor regains focus,
// seamlessly handing back to the native `::selection` styling.
//
// Addressed edge cases:
//   1. rAF timing race — pending blur is cancelled if focus returns first
//   2. Double-display flicker — focus clears decorations synchronously
//   3. Drag-outside blur — mouse-held state suppresses blur decorations
//   4. Stale decorations — selection changes while blurred update the range

import { definePlugin, type Extension } from "prosekit/core";
import type { Node } from "prosekit/pm/model";
import { Plugin, PluginKey } from "prosekit/pm/state";
import { Decoration, DecorationSet } from "prosekit/pm/view";

// ── Constants ──

const pluginKey = new PluginKey<DecorationSet>("blur-selection");

/**
 * Transaction metadata key.
 * - `true`  → editor blurred, build selection decorations
 * - `false` → editor focused, clear decorations
 */
const BLUR_META = "blur-selection-active";

/** CSS class applied to the inline decorations. Style in `editor.css`. */
const BLUR_CLASS = "pm-selection-blur";

// ── Helpers ──

/** Build a decoration set for the current selection, or empty if collapsed. */
function decorationsForSelection(doc: Node, from: number, to: number): DecorationSet {
  if (from === to) return DecorationSet.empty;
  return DecorationSet.create(doc, [Decoration.inline(from, to, { class: BLUR_CLASS })]);
}

// ── Extension ──

/**
 * Returns a ProseKit Extension that highlights the selection on blur.
 *
 * How it works:
 *   1. `blur`  DOM event → schedule decoration creation (cancellable)
 *   2. Plugin state creates `Decoration.inline` over the selection range
 *   3. `focus` DOM event → cancel any pending blur, clear decorations
 *   4. Selection changes while blurred → decorations follow the new range
 *   5. Mouse drag in progress → blur decorations suppressed entirely
 */
function defineBlurSelection(): Extension {
  // ── Mutable state shared between DOM handlers ──

  /** ID of the pending `requestAnimationFrame` for blur dispatch. */
  let pendingBlurRaf: number | null = null;

  /** Whether a mouse button is currently held down (drag in progress). */
  let mouseDown = false;

  /** Whether the plugin considers the editor "blurred with decorations". */
  let isBlurred = false;

  /** Cancel any scheduled blur dispatch. */
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
        init() {
          return DecorationSet.empty;
        },

        apply(tr, decorations, _oldState, newState) {
          const meta = tr.getMeta(BLUR_META);

          // Blur: create decorations for the current selection
          if (meta === true) {
            const { from, to } = tr.selection;
            return decorationsForSelection(tr.doc, from, to);
          }

          // Focus: clear all decorations immediately
          if (meta === false) {
            return DecorationSet.empty;
          }

          // Nothing active — skip processing
          if (decorations === DecorationSet.empty) {
            return DecorationSet.empty;
          }

          // [Fix #4] Selection changed while blurred — rebuild decorations
          // for the new range so the highlight follows the selection.
          if (tr.selectionSet) {
            const { from, to } = newState.selection;
            return decorationsForSelection(newState.doc, from, to);
          }

          // Doc changed while blurred — map decorations to new positions
          if (tr.docChanged) {
            return decorations.map(tr.mapping, tr.doc);
          }

          return decorations;
        },
      },

      props: {
        decorations(state) {
          return pluginKey.getState(state) ?? DecorationSet.empty;
        },

        handleDOMEvents: {
          // ── [Fix #3] Track mouse-held state to suppress drag-blur ──

          mousedown(_view, event: MouseEvent) {
            // Only track left-button drags (button 0).
            // Right-click (button 2) opens context menus and should NOT
            // suppress blur decorations.
            if (event.button === 0) mouseDown = true;
            return false;
          },

          mouseup(_view, event: MouseEvent) {
            if (event.button === 0) mouseDown = false;
            return false;
          },

          // ── Blur / Focus handlers ──

          blur(view) {
            // [Fix #3] Don't create blur decorations during a drag — the
            // user is actively selecting text and the editor will regain
            // focus when the mouse is released.
            if (mouseDown) return false;

            const { empty } = view.state.selection;
            if (empty) return false;

            // [Fix #1] Cancel any previous pending blur (shouldn't happen,
            // but be defensive).
            cancelPendingBlur();

            // Schedule decoration creation for the next frame so the
            // browser finishes processing the focus change first.
            pendingBlurRaf = requestAnimationFrame(() => {
              pendingBlurRaf = null;

              // Guard: editor might have been destroyed, re-focused, or
              // a drag started in the meantime.
              if (view.isDestroyed || view.hasFocus() || mouseDown) return;

              const { empty: nowEmpty } = view.state.selection;
              if (nowEmpty) return;

              isBlurred = true;
              view.dispatch(view.state.tr.setMeta(BLUR_META, true));
            });

            return false;
          },

          focus(view) {
            // [Fix #1] If blur was scheduled but hasn't fired yet, cancel
            // it entirely — no decorations are needed.
            cancelPendingBlur();

            // [Fix #2] Clear decorations synchronously on focus to avoid
            // a frame where both the decoration and native ::selection
            // are visible simultaneously.
            if (isBlurred) {
              isBlurred = false;
              const current = pluginKey.getState(view.state);
              if (current && current !== DecorationSet.empty) {
                view.dispatch(view.state.tr.setMeta(BLUR_META, false));
              }
            }

            return false;
          },
        },
      },
    }),
  );
}

// ── Exports ──

export { defineBlurSelection, BLUR_CLASS };
