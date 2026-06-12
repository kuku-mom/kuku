// @vitest-environment jsdom

import { createEditor, defineNodeSpec, union } from "prosekit/core";
import { defineDoc } from "prosekit/extensions/doc";
import { defineParagraph } from "prosekit/extensions/paragraph";
import { defineText } from "prosekit/extensions/text";
import { describe, expect, it } from "vitest";

import {
  focusOrCreateEditorEndParagraph,
  isEditorEndBlankPointerDown,
} from "./editor_end_affordance";

function defineTestCodeBlock() {
  return defineNodeSpec({
    name: "codeBlock",
    content: "text*",
    group: "block",
    code: true,
    defining: true,
    marks: "",
    toDOM: () => ["pre", ["code", 0]],
  });
}

function createTestEditor() {
  return createEditor({
    extension: union(defineDoc(), defineText(), defineParagraph(), defineTestCodeBlock()),
  });
}

function mountTestEditor() {
  const editor = createTestEditor();
  const host = document.createElement("div");
  document.body.append(host);
  editor.mount(host);
  return { editor, host };
}

function mockRect(element: HTMLElement, rect: Pick<DOMRect, "bottom" | "left" | "right" | "top">) {
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      bottom: rect.bottom,
      height: rect.bottom - rect.top,
      left: rect.left,
      right: rect.right,
      top: rect.top,
      width: rect.right - rect.left,
      x: rect.left,
      y: rect.top,
      toJSON: () => ({}),
    }),
  });
}

function pointerEventLike(
  target: EventTarget,
  overrides: Partial<Parameters<typeof isEditorEndBlankPointerDown>[0]> = {},
): Parameters<typeof isEditorEndBlankPointerDown>[0] {
  return {
    altKey: false,
    button: 0,
    clientX: 40,
    clientY: 120,
    ctrlKey: false,
    defaultPrevented: false,
    metaKey: false,
    shiftKey: false,
    target,
    ...overrides,
  };
}

describe("editor end affordance", () => {
  it("treats clicks below the last editor child as end-blank clicks", () => {
    const editorDom = document.createElement("div");
    const paragraph = document.createElement("p");
    editorDom.append(paragraph);
    document.body.append(editorDom);

    mockRect(editorDom, { bottom: 200, left: 0, right: 100, top: 0 });
    mockRect(paragraph, { bottom: 80, left: 0, right: 100, top: 40 });

    expect(isEditorEndBlankPointerDown(pointerEventLike(editorDom), editorDom)).toBe(true);
  });

  it("ignores clicks on real editor content", () => {
    const editorDom = document.createElement("div");
    const paragraph = document.createElement("p");
    editorDom.append(paragraph);
    document.body.append(editorDom);

    mockRect(editorDom, { bottom: 200, left: 0, right: 100, top: 0 });
    mockRect(paragraph, { bottom: 80, left: 0, right: 100, top: 40 });

    expect(
      isEditorEndBlankPointerDown(pointerEventLike(paragraph, { clientY: 60 }), editorDom),
    ).toBe(false);
  });

  it("appends an empty paragraph after a terminal code block", () => {
    const { editor, host } = mountTestEditor();
    editor.setContent({
      type: "doc",
      content: [
        {
          type: "codeBlock",
          content: [{ type: "text", text: "const x = 1;" }],
        },
      ],
    });

    expect(focusOrCreateEditorEndParagraph(editor.view)).toBe(true);

    expect(editor.getDocJSON()).toEqual({
      type: "doc",
      content: [
        {
          type: "codeBlock",
          content: [{ type: "text", text: "const x = 1;" }],
        },
        { type: "paragraph" },
      ],
    });
    expect(editor.view.state.selection.from).toBe(editor.view.state.doc.content.size - 1);

    host.remove();
  });

  it("focuses the existing trailing empty paragraph instead of appending another", () => {
    const { editor, host } = mountTestEditor();
    editor.setContent({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "done" }],
        },
        { type: "paragraph" },
      ],
    });

    expect(focusOrCreateEditorEndParagraph(editor.view)).toBe(true);

    expect(editor.getDocJSON()).toEqual({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "done" }],
        },
        { type: "paragraph" },
      ],
    });
    expect(editor.view.state.selection.from).toBe(editor.view.state.doc.content.size - 1);

    host.remove();
  });
});
