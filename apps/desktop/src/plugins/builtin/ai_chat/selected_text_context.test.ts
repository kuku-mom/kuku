import { describe, expect, it } from "vitest";

import { MAX_SELECTED_TEXT_BYTES, prepareSelectedTextForSend } from "./selected_text_context";
import type { EditorContext } from "./types";

function editorContext(overrides: Partial<EditorContext> = {}): EditorContext {
  return {
    activeFile: null,
    selectedText: null,
    embeddedFiles: [],
    ...overrides,
  };
}

describe("ai_chat selected_text_context", () => {
  it("returns no context when selection is absent", () => {
    expect(prepareSelectedTextForSend(editorContext())).toEqual({
      selectedText: null,
    });
  });

  it("returns selected text and message metadata when included", () => {
    expect(
      prepareSelectedTextForSend(
        editorContext({
          activeFile: "notes/Base.md",
          selectedText: "selected paragraph",
        }),
      ),
    ).toEqual({
      selectedText: "selected paragraph",
      messageAttachment: {
        kind: "selection",
        activeFile: "notes/Base.md",
        sizeBytes: 18,
      },
    });
  });

  it("can explicitly disable selected text", () => {
    expect(
      prepareSelectedTextForSend(
        editorContext({
          activeFile: "notes/Base.md",
          selectedText: "selected paragraph",
        }),
        false,
      ),
    ).toEqual({
      selectedText: null,
    });
  });

  it("rejects selected text over the size limit", () => {
    expect(() =>
      prepareSelectedTextForSend(
        editorContext({
          selectedText: "a".repeat(MAX_SELECTED_TEXT_BYTES + 1),
        }),
      ),
    ).toThrow("Selected text is too large to include");
  });
});
