// @vitest-environment jsdom

import { createEditor, union } from "prosekit/core";
import { defineDoc } from "prosekit/extensions/doc";
import { defineParagraph } from "prosekit/extensions/paragraph";
import { defineText } from "prosekit/extensions/text";
import { TextSelection } from "prosekit/pm/state";
import { type EditorView, DecorationSet } from "prosekit/pm/view";
import { describe, expect, it, vi } from "vitest";

import { defineBlurSelection, SELECTION_CLASS } from "../blur_selection";

// ── Helpers ──

function createTestEditor() {
  return createEditor({
    extension: union(defineDoc(), defineText(), defineParagraph(), defineBlurSelection()),
  });
}

/** Access the underlying ProseMirror EditorView via prosekit's public API. */
function getView(editor: ReturnType<typeof createTestEditor>): EditorView {
  return editor.view;
}

function mountEditor() {
  const editor = createTestEditor();
  const div = document.createElement("div");
  document.body.appendChild(div);
  editor.mount(div);

  editor.setContent({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: "Hello world" }],
      },
    ],
  } as Parameters<typeof editor.setContent>[0]);

  return { editor, div };
}

/**
 * Retrieve the plugin's decoration set from the current editor state.
 * Walks through all plugin states to find the DecorationSet produced by
 * the selection-highlight plugin (state is a plain DecorationSet, not wrapped).
 */
function getPluginDecorations(editor: ReturnType<typeof createTestEditor>): DecorationSet {
  const view = getView(editor);
  const state = view.state;

  for (const plugin of state.plugins) {
    const pluginState = plugin.getState(state);
    if (pluginState instanceof DecorationSet) {
      return pluginState;
    }
  }

  return DecorationSet.empty;
}

// ── Tests ──

describe("Custom selection highlight", () => {
  // ────────────────────────────────────────────────────────────────────
  // Regression: focus/blur must NOT dispatch a ProseMirror transaction.
  //
  // Dispatching during focus/blur causes the browser to reset the scroll
  // position, producing a jarring jump when switching windows/tabs.
  // ────────────────────────────────────────────────────────────────────

  describe("no dispatch on focus/blur", () => {
    it("should not dispatch a transaction when the editor receives focus", () => {
      const { editor, div } = mountEditor();
      const view = getView(editor);

      // Set a non-collapsed selection so the plugin has something to react to
      const state = view.state;
      const tr = state.tr.setSelection(TextSelection.create(state.doc, 1, 6));
      view.dispatch(tr);

      // Spy on dispatch to count calls
      const dispatchSpy = vi.spyOn(view, "dispatch");

      // Simulate a focus event
      view.dom.dispatchEvent(new FocusEvent("focus"));

      expect(dispatchSpy).not.toHaveBeenCalled();

      dispatchSpy.mockRestore();
      div.remove();
    });

    it("should not dispatch a transaction when the editor loses focus", () => {
      const { editor, div } = mountEditor();
      const view = getView(editor);

      // Set a non-collapsed selection
      const state = view.state;
      const tr = state.tr.setSelection(TextSelection.create(state.doc, 1, 6));
      view.dispatch(tr);

      // Spy on dispatch to count calls
      const dispatchSpy = vi.spyOn(view, "dispatch");

      // Simulate a blur event
      view.dom.dispatchEvent(new FocusEvent("blur"));

      // The old implementation scheduled a rAF, so flush timers to catch
      // any deferred dispatch as well.
      vi.useFakeTimers();
      vi.runAllTimers();
      vi.useRealTimers();

      expect(dispatchSpy).not.toHaveBeenCalled();

      dispatchSpy.mockRestore();
      div.remove();
    });

    it("should not dispatch on rapid blur→focus sequences", () => {
      const { editor, div } = mountEditor();
      const view = getView(editor);

      // Set a non-collapsed selection
      const state = view.state;
      const tr = state.tr.setSelection(TextSelection.create(state.doc, 1, 6));
      view.dispatch(tr);

      const dispatchSpy = vi.spyOn(view, "dispatch");

      // Simulate rapid blur→focus (e.g. clicking a toolbar button)
      view.dom.dispatchEvent(new FocusEvent("blur"));
      view.dom.dispatchEvent(new FocusEvent("focus"));

      vi.useFakeTimers();
      vi.runAllTimers();
      vi.useRealTimers();

      expect(dispatchSpy).not.toHaveBeenCalled();

      dispatchSpy.mockRestore();
      div.remove();
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Decorations should accurately track the current selection.
  // ────────────────────────────────────────────────────────────────────

  describe("decorations track selection", () => {
    it("should produce decorations for a non-collapsed selection", () => {
      const { editor, div } = mountEditor();
      const view = getView(editor);

      // Select "Hello" (positions 1–6 in a paragraph)
      const state = view.state;
      const tr = state.tr.setSelection(TextSelection.create(state.doc, 1, 6));
      view.dispatch(tr);

      const decorations = getPluginDecorations(editor);
      const found = decorations.find(1, 6);

      expect(found.length).toBeGreaterThan(0);
      expect(found[0].from).toBe(1);
      expect(found[0].to).toBe(6);

      div.remove();
    });

    it("should apply SELECTION_CLASS to decoration", () => {
      const { editor, div } = mountEditor();
      const view = getView(editor);

      const state = view.state;
      const tr = state.tr.setSelection(TextSelection.create(state.doc, 1, 6));
      view.dispatch(tr);

      const decorations = getPluginDecorations(editor);
      const found = decorations.find(1, 6);

      expect(found.length).toBeGreaterThan(0);

      // Decoration spec stores the attrs; for inline decorations the class
      // is in the attrs object.
      const spec = (found[0] as unknown as { type: { attrs: { class: string } } }).type.attrs;
      expect(spec.class).toBe(SELECTION_CLASS);

      div.remove();
    });

    it("should update decorations when selection changes", () => {
      const { editor, div } = mountEditor();
      const view = getView(editor);

      // First selection: positions 1–6
      let state = view.state;
      let tr = state.tr.setSelection(TextSelection.create(state.doc, 1, 6));
      view.dispatch(tr);

      let decorations = getPluginDecorations(editor);
      let found = decorations.find(1, 6);
      expect(found.length).toBe(1);
      expect(found[0].from).toBe(1);
      expect(found[0].to).toBe(6);

      // Change selection to positions 3–9
      state = view.state;
      tr = state.tr.setSelection(TextSelection.create(state.doc, 3, 9));
      view.dispatch(tr);

      decorations = getPluginDecorations(editor);
      found = decorations.find(3, 9);
      expect(found.length).toBe(1);
      expect(found[0].from).toBe(3);
      expect(found[0].to).toBe(9);

      div.remove();
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Collapsed selections (cursor) should yield no decorations.
  // ────────────────────────────────────────────────────────────────────

  describe("collapsed selection produces no decorations", () => {
    it("should have empty decorations when selection is collapsed", () => {
      const { editor, div } = mountEditor();
      const view = getView(editor);

      // Place cursor at position 3 (collapsed)
      const state = view.state;
      const tr = state.tr.setSelection(TextSelection.create(state.doc, 3));
      view.dispatch(tr);

      const decorations = getPluginDecorations(editor);
      expect(decorations).toBe(DecorationSet.empty);

      div.remove();
    });

    it("should clear decorations when selection collapses after being expanded", () => {
      const { editor, div } = mountEditor();
      const view = getView(editor);

      // First: non-collapsed selection
      let state = view.state;
      let tr = state.tr.setSelection(TextSelection.create(state.doc, 1, 6));
      view.dispatch(tr);

      let decorations = getPluginDecorations(editor);
      expect(decorations.find(1, 6).length).toBeGreaterThan(0);

      // Then: collapse selection to cursor
      state = view.state;
      tr = state.tr.setSelection(TextSelection.create(state.doc, 3));
      view.dispatch(tr);

      decorations = getPluginDecorations(editor);
      expect(decorations).toBe(DecorationSet.empty);

      div.remove();
    });
  });
});
