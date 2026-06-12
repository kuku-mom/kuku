// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import type { CodeBlockPreviewRenderer } from "../code_block_preview_renderers";
import {
  createInitialCodeBlockPreviewRenderOptionsForTest,
  shouldDeferCodeBlockPreviewThemeRefreshForTest,
} from "../nodes/code_mirror_node_view";

function renderer(overrides: Partial<CodeBlockPreviewRenderer> = {}): CodeBlockPreviewRenderer {
  return {
    id: "preview",
    matches: () => true,
    render: () => undefined,
    ...overrides,
  };
}

function mockRect(element: HTMLElement, rect: Pick<DOMRect, "bottom" | "top">): void {
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => rect,
  });
}

describe("code mirror code block preview options", () => {
  it("uses renderer hints to stabilize initial eager renders", () => {
    expect(
      createInitialCodeBlockPreviewRenderOptionsForTest(
        renderer({
          preserveScrollAnchorOnRender: true,
          reserveEstimatedHeight: true,
        }),
      ),
    ).toEqual({
      preserveScrollAnchor: true,
      reserveEstimatedHeight: true,
    });

    expect(createInitialCodeBlockPreviewRenderOptionsForTest(renderer())).toEqual({
      preserveScrollAnchor: false,
      reserveEstimatedHeight: false,
    });
  });

  it("allows theme refresh to defer independently from initial render", () => {
    const viewport = document.createElement("div");
    const editorRoot = document.createElement("div");
    const previewBody = document.createElement("div");
    viewport.dataset.scrollAreaViewport = "";
    editorRoot.append(previewBody);
    viewport.append(editorRoot);
    document.body.append(viewport);

    mockRect(viewport, { bottom: 700, top: 100 });
    mockRect(previewBody, { bottom: 2900, top: 2800 });

    expect(
      shouldDeferCodeBlockPreviewThemeRefreshForTest(
        renderer({ deferThemeRefreshUntilVisible: true }),
        previewBody,
        editorRoot,
      ),
    ).toBe(true);

    expect(
      shouldDeferCodeBlockPreviewThemeRefreshForTest(renderer(), previewBody, editorRoot),
    ).toBe(false);

    mockRect(previewBody, { bottom: 260, top: 200 });

    expect(
      shouldDeferCodeBlockPreviewThemeRefreshForTest(
        renderer({ deferThemeRefreshUntilVisible: true }),
        previewBody,
        editorRoot,
      ),
    ).toBe(false);
  });
});
