import { createEditor, union } from "prosekit/core";
import { defineDoc } from "prosekit/extensions/doc";
import { defineParagraph } from "prosekit/extensions/paragraph";
import { defineText } from "prosekit/extensions/text";
import { listInputRules } from "prosemirror-flat-list";
import { describe, expect, it } from "vitest";

import { defineHeading } from "../nodes/heading";
import { defineList, shouldAutoWrapListInputRule } from "../nodes/list";

function createTestEditor() {
  return createEditor({
    extension: union(defineDoc(), defineText(), defineParagraph(), defineHeading(), defineList()),
  });
}

function applyOrderedListInput(doc: { type: "doc"; content: Record<string, unknown>[] }): {
  type: string;
  content?: Record<string, unknown>[];
} {
  const editor = createTestEditor();
  const orderedListRule = shouldAutoWrapListInputRule(listInputRules[1]);

  // @ts-expect-error – test helper passes a plain JSON object
  editor.setContent(doc, "end");

  // @ts-expect-error – accessing private instance for test
  const state = editor.instance.getState();
  // @ts-expect-error – handler exists at runtime but is not in the type
  const transaction = orderedListRule.handler(
    state,
    ["1. ", "1"] as unknown as RegExpMatchArray,
    1,
    3,
  );

  if (transaction) {
    // @ts-expect-error – accessing private instance for test
    editor.instance.dispatch(transaction);
  } else {
    // @ts-expect-error – accessing private instance for test
    editor.instance.dispatch(state.tr.insertText(" ", state.selection.from, state.selection.to));
  }

  return editor.getDocJSON() as { type: string; content?: Record<string, unknown>[] };
}

describe("guarded list input rules", () => {
  it("keeps ordered-list markdown literal inside headings", () => {
    expect(
      applyOrderedListInput({
        type: "doc",
        content: [
          {
            type: "heading",
            attrs: { level: 1 },
            content: [{ type: "text", text: "1." }],
          },
        ],
      }),
    ).toEqual({
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 1 },
          content: [{ type: "text", text: "1. " }],
        },
      ],
    });
  });

  it("still turns paragraphs into ordered lists", () => {
    expect(
      applyOrderedListInput({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "1." }],
          },
        ],
      }),
    ).toEqual({
      type: "doc",
      content: [
        {
          type: "list",
          attrs: {
            kind: "ordered",
            order: null,
            checked: false,
            collapsed: false,
          },
          content: [{ type: "paragraph" }],
        },
      ],
    });
  });
});
