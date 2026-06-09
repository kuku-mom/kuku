// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";

import {
  captureCodeBlockScrollAnchorForTest,
  restoreCodeBlockScrollAnchorForTest,
} from "../nodes/code_mirror_node_view";

function mockRect(element: HTMLElement, rect: Pick<DOMRect, "bottom" | "height" | "top">): void {
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => rect,
  });
}

describe("code mirror code block scroll anchor", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("restores the editor viewport when content above the anchor changes height", () => {
    const scrollRoot = document.createElement("div");
    const viewport = document.createElement("div");
    const editor = document.createElement("div");
    const blockAbove = document.createElement("p");
    const anchorBlock = document.createElement("p");

    scrollRoot.dataset.editorScroll = "";
    viewport.dataset.scrollAreaViewport = "";
    editor.className = "ProseMirror";
    editor.append(blockAbove, anchorBlock);
    viewport.append(editor);
    scrollRoot.append(viewport);
    document.body.append(scrollRoot);

    viewport.scrollTop = 200;
    mockRect(viewport, { bottom: 700, height: 600, top: 100 });
    mockRect(blockAbove, { bottom: 80, height: 80, top: 0 });
    mockRect(anchorBlock, { bottom: 160, height: 40, top: 120 });

    const anchor = captureCodeBlockScrollAnchorForTest(document);
    mockRect(anchorBlock, { bottom: 120, height: 40, top: 80 });

    restoreCodeBlockScrollAnchorForTest(anchor);

    expect(viewport.scrollTop).toBe(160);
  });

  it("allows repeated restores from the same render cycle", () => {
    const scrollRoot = document.createElement("div");
    const viewport = document.createElement("div");
    const editor = document.createElement("div");
    const anchorBlock = document.createElement("p");

    scrollRoot.dataset.editorScroll = "";
    viewport.dataset.scrollAreaViewport = "";
    editor.className = "ProseMirror";
    editor.append(anchorBlock);
    viewport.append(editor);
    scrollRoot.append(viewport);
    document.body.append(scrollRoot);

    viewport.scrollTop = 200;
    mockRect(viewport, { bottom: 700, height: 600, top: 100 });
    mockRect(anchorBlock, { bottom: 160, height: 40, top: 120 });

    const anchor = captureCodeBlockScrollAnchorForTest(document);
    mockRect(anchorBlock, { bottom: 120, height: 40, top: 80 });
    restoreCodeBlockScrollAnchorForTest(anchor);

    mockRect(anchorBlock, { bottom: 140, height: 40, top: 100 });
    restoreCodeBlockScrollAnchorForTest(anchor);

    expect(viewport.scrollTop).toBe(140);
  });

  it("does not restore the viewport after the user scrolls", () => {
    const scrollRoot = document.createElement("div");
    const viewport = document.createElement("div");
    const editor = document.createElement("div");
    const anchorBlock = document.createElement("p");

    scrollRoot.dataset.editorScroll = "";
    viewport.dataset.scrollAreaViewport = "";
    editor.className = "ProseMirror";
    editor.append(anchorBlock);
    viewport.append(editor);
    scrollRoot.append(viewport);
    document.body.append(scrollRoot);

    viewport.scrollTop = 200;
    mockRect(viewport, { bottom: 700, height: 600, top: 100 });
    mockRect(anchorBlock, { bottom: 160, height: 40, top: 120 });

    const anchor = captureCodeBlockScrollAnchorForTest(document);
    viewport.scrollTop = 240;
    mockRect(anchorBlock, { bottom: 120, height: 40, top: 80 });

    restoreCodeBlockScrollAnchorForTest(anchor);

    expect(viewport.scrollTop).toBe(240);
  });
});
