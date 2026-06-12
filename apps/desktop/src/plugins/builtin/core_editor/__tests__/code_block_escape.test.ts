// @vitest-environment jsdom

import { createEditor, defineNodeSpec, union } from "prosekit/core";
import { defineDoc } from "prosekit/extensions/doc";
import { defineParagraph } from "prosekit/extensions/paragraph";
import { defineText } from "prosekit/extensions/text";
import type { Node as ProseMirrorNode } from "prosekit/pm/model";
import { NodeSelection } from "prosekit/pm/state";
import type { EditorView } from "prosekit/pm/view";
import { describe, expect, it } from "vitest";

import {
  convertEmptyCodeBlockToParagraphForTest,
  defineCodeMirrorCodeBlockView,
  moveSelectionAfterCodeBlockForTest,
  moveSelectionBeforeCodeBlockForTest,
  selectCodeBlockNodeForTest,
} from "../nodes/code_mirror_node_view";

function defineTestCodeBlock() {
  return defineNodeSpec({
    name: "codeBlock",
    content: "text*",
    group: "block",
    code: true,
    defining: true,
    marks: "",
    attrs: {
      language: { default: "" },
    },
    toDOM: () => ["pre", ["code", 0]],
  });
}

function createTestEditor() {
  return createEditor({
    extension: union(defineDoc(), defineText(), defineParagraph(), defineTestCodeBlock()),
  });
}

function createTestEditorWithNodeView() {
  return createEditor({
    extension: union(
      defineDoc(),
      defineText(),
      defineParagraph(),
      defineTestCodeBlock(),
      defineCodeMirrorCodeBlockView(),
    ),
  });
}

function mountEditor(content: Parameters<ReturnType<typeof createTestEditor>["setContent"]>[0]) {
  const editor = createTestEditor();
  const host = document.createElement("div");
  document.body.append(host);
  editor.mount(host);
  editor.setContent(content);
  return { editor, host, view: editor.view };
}

function mountEditorWithNodeView(
  content: Parameters<ReturnType<typeof createTestEditorWithNodeView>["setContent"]>[0],
) {
  const editor = createTestEditorWithNodeView();
  const host = document.createElement("div");
  document.body.append(host);
  editor.mount(host);
  editor.setContent(content);
  return { editor, host, view: editor.view };
}

function findCodeBlock(view: EditorView, ordinal = 0): { node: ProseMirrorNode; pos: number } {
  let seen = 0;
  let result: { node: ProseMirrorNode; pos: number } | null = null;

  view.state.doc.descendants((node, pos) => {
    if (result || node.type.name !== "codeBlock") return false;
    if (seen === ordinal) {
      result = { node, pos };
      return false;
    }
    seen += 1;
    return true;
  });

  if (!result) {
    throw new Error(`Missing code block ${ordinal}`);
  }
  return result;
}

describe("code block escape helpers", () => {
  it("creates and focuses a paragraph after a terminal code block", () => {
    const { editor, host, view } = mountEditor({
      type: "doc",
      content: [
        {
          type: "codeBlock",
          content: [{ type: "text", text: "const x = 1;" }],
        },
      ],
    });
    const block = findCodeBlock(view);

    expect(
      moveSelectionAfterCodeBlockForTest(view, block.pos, block.node, {
        createParagraph: true,
        preferParagraph: true,
      }),
    ).toBe(true);

    expect(editor.getDocJSON()).toEqual({
      type: "doc",
      content: [
        {
          type: "codeBlock",
          attrs: { language: "" },
          content: [{ type: "text", text: "const x = 1;" }],
        },
        { type: "paragraph" },
      ],
    });
    expect(view.state.selection.$from.parent.type.name).toBe("paragraph");

    host.remove();
  });

  it("reuses an existing following paragraph for explicit exit", () => {
    const { editor, host, view } = mountEditor({
      type: "doc",
      content: [
        {
          type: "codeBlock",
          content: [{ type: "text", text: "const x = 1;" }],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "after" }],
        },
      ],
    });
    const block = findCodeBlock(view);

    expect(
      moveSelectionAfterCodeBlockForTest(view, block.pos, block.node, {
        createParagraph: true,
        preferParagraph: true,
      }),
    ).toBe(true);

    expect(editor.getDocJSON()).toEqual({
      type: "doc",
      content: [
        {
          type: "codeBlock",
          attrs: { language: "" },
          content: [{ type: "text", text: "const x = 1;" }],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "after" }],
        },
      ],
    });
    expect(view.state.selection.$from.parent.type.name).toBe("paragraph");
    expect(view.state.selection.$from.parentOffset).toBe(0);

    host.remove();
  });

  it("enters a following code block instead of inserting a paragraph for arrow escape", () => {
    const { editor, host, view } = mountEditor({
      type: "doc",
      content: [
        {
          type: "codeBlock",
          content: [{ type: "text", text: "first" }],
        },
        {
          type: "codeBlock",
          content: [{ type: "text", text: "second" }],
        },
      ],
    });
    const block = findCodeBlock(view);

    expect(
      moveSelectionAfterCodeBlockForTest(view, block.pos, block.node, {
        createParagraph: true,
      }),
    ).toBe(true);

    expect(editor.getDocJSON()).toEqual({
      type: "doc",
      content: [
        {
          type: "codeBlock",
          attrs: { language: "" },
          content: [{ type: "text", text: "first" }],
        },
        {
          type: "codeBlock",
          attrs: { language: "" },
          content: [{ type: "text", text: "second" }],
        },
      ],
    });
    expect(view.state.selection.$from.parent.type.name).toBe("codeBlock");
    expect(view.state.selection.$from.parent.textContent).toBe("second");
    expect(view.state.selection.$from.parentOffset).toBe(0);

    host.remove();
  });

  it("does not mutate the document when escaping before the first code block", () => {
    const { editor, host, view } = mountEditor({
      type: "doc",
      content: [
        {
          type: "codeBlock",
          content: [{ type: "text", text: "first" }],
        },
      ],
    });
    const before = editor.getDocJSON();
    const block = findCodeBlock(view);

    expect(moveSelectionBeforeCodeBlockForTest(view, block.pos, block.node)).toBe(false);
    expect(editor.getDocJSON()).toEqual(before);

    host.remove();
  });

  it("moves to a previous block when escaping backward", () => {
    const { host, view } = mountEditor({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "before" }],
        },
        {
          type: "codeBlock",
          content: [{ type: "text", text: "code" }],
        },
      ],
    });
    const block = findCodeBlock(view);

    expect(moveSelectionBeforeCodeBlockForTest(view, block.pos, block.node)).toBe(true);
    expect(view.state.selection.$from.parent.type.name).toBe("paragraph");

    host.remove();
  });

  it("converts an empty code block to a paragraph", () => {
    const { editor, host, view } = mountEditor({
      type: "doc",
      content: [{ type: "codeBlock" }],
    });
    const block = findCodeBlock(view);

    expect(convertEmptyCodeBlockToParagraphForTest(view, block.pos, block.node)).toBe(true);

    expect(editor.getDocJSON()).toEqual({
      type: "doc",
      content: [{ type: "paragraph" }],
    });
    expect(view.state.selection.$from.parent.type.name).toBe("paragraph");

    host.remove();
  });

  it("does not convert a non-empty code block to a paragraph", () => {
    const { editor, host, view } = mountEditor({
      type: "doc",
      content: [
        {
          type: "codeBlock",
          content: [{ type: "text", text: "code" }],
        },
      ],
    });
    const before = editor.getDocJSON();
    const block = findCodeBlock(view);

    expect(convertEmptyCodeBlockToParagraphForTest(view, block.pos, block.node)).toBe(false);
    expect(editor.getDocJSON()).toEqual(before);

    host.remove();
  });

  it("selects the code block node so the outer editor can delete it", () => {
    const { editor, host, view } = mountEditorWithNodeView({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "before" }],
        },
        {
          type: "codeBlock",
          content: [{ type: "text", text: "code" }],
        },
      ],
    });
    const block = findCodeBlock(view);

    expect(selectCodeBlockNodeForTest(view, block.pos, block.node)).toBe(true);

    expect(view.state.selection).toBeInstanceOf(NodeSelection);
    expect(view.state.selection.from).toBe(block.pos);
    expect(
      host
        .querySelector<HTMLElement>("[data-kuku-code-mirror-block]")
        ?.classList.contains("ProseMirror-selectednode"),
    ).toBe(true);

    view.dispatch(view.state.tr.deleteSelection());

    expect(editor.getDocJSON()).toEqual({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "before" }],
        },
      ],
    });

    host.remove();
  });

  it("selects the code block node when pressing Escape from the language input", () => {
    const { host, view } = mountEditorWithNodeView({
      type: "doc",
      content: [
        {
          type: "codeBlock",
          attrs: { language: "ts" },
          content: [{ type: "text", text: "const x = 1;" }],
        },
      ],
    });
    const input = host.querySelector<HTMLInputElement>("[data-kuku-code-block-language-input]");
    if (!input) {
      throw new Error("Missing code block language input");
    }

    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Escape",
    });
    input.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(view.state.selection).toBeInstanceOf(NodeSelection);
    expect(
      host
        .querySelector<HTMLElement>("[data-kuku-code-mirror-block]")
        ?.classList.contains("ProseMirror-selectednode"),
    ).toBe(true);

    host.remove();
  });
});
