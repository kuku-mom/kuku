import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Editor } from "prosekit/core";

import {
  filterEditorSlashItems,
  insertImageBySrc,
  pasteImageFromClipboard,
  registerDefaultEditorSlashItems,
} from "../slash_items";

describe("core-editor image slash item", () => {
  let dispose: (() => void) | undefined;

  beforeEach(() => {
    dispose = registerDefaultEditorSlashItems();
  });

  afterEach(() => {
    dispose?.();
    vi.restoreAllMocks();
  });

  it("registers the image slash item with 4 submenu options", () => {
    const items = filterEditorSlashItems("image");
    const imageItem = items.find((item) => item.id === "core-editor.image");
    expect(imageItem).toBeDefined();
    expect(imageItem?.submenu?.map((sub) => sub.id)).toEqual([
      "core-editor.image.select-file",
      "core-editor.image.clipboard",
      "core-editor.image.url",
      "core-editor.image.dropzone",
    ]);
  });

  it("inserts an image by URL via the url-input submenu item", () => {
    const insertImageCmd = vi.fn();
    const fakeEditor = {
      commands: {
        insertImage: insertImageCmd,
      },
    } as unknown as Editor;

    const items = filterEditorSlashItems("image");
    const imageItem = items.find((item) => item.id === "core-editor.image");
    const urlSubItem = imageItem?.submenu?.find((sub) => sub.id === "core-editor.image.url");

    expect(urlSubItem?.kind).toBe("url-input");
    urlSubItem?.onSubmitUrl?.(fakeEditor, "  https://example.com/pic.png  ");

    expect(insertImageCmd).toHaveBeenCalledWith({
      src: "https://example.com/pic.png",
    });
  });

  it("pastes a markdown image or URL from the clipboard", async () => {
    const insertImageCmd = vi.fn();
    const fakeEditor = {
      commands: {
        insertImage: insertImageCmd,
      },
    } as unknown as Editor;

    Object.defineProperty(globalThis, "navigator", {
      value: {
        clipboard: {
          readText: vi.fn().mockResolvedValue("![Diagram](https://example.com/diagram.png)"),
        },
      },
      configurable: true,
    });

    await pasteImageFromClipboard(fakeEditor);

    expect(insertImageCmd).toHaveBeenCalledWith({
      src: "https://example.com/diagram.png",
      alt: "Diagram",
    });
  });

  it("ignores empty URLs in insertImageBySrc", () => {
    const insertImageCmd = vi.fn();
    const fakeEditor = {
      commands: {
        insertImage: insertImageCmd,
      },
    } as unknown as Editor;

    expect(insertImageBySrc(fakeEditor, "   ")).toBe(false);
    expect(insertImageCmd).not.toHaveBeenCalled();
  });
});
