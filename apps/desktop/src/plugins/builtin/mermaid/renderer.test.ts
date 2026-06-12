// @vitest-environment jsdom

import mermaid from "mermaid";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CodeBlockPreviewRenderContext } from "~/plugins/builtin/core_editor/code_block_preview_renderers";
import { clearMermaidRenderQueue } from "./render_queue";
import { clearMermaidPreviewRuntimeCache } from "./runtime_cache";
import { mermaidCodeBlockPreviewRenderer } from "./renderer";

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(),
  },
}));

function createRenderContext(
  source: string,
  options: Partial<Pick<CodeBlockPreviewRenderContext, "preserveCurrent" | "isCurrent">> = {},
): CodeBlockPreviewRenderContext {
  const root = document.createElement("div");
  const editorRoot = document.createElement("div");
  const previewBody = document.createElement("div");

  editorRoot.dataset.kukuCodeBlock = "";
  editorRoot.append(previewBody);
  root.append(editorRoot);
  document.body.append(root);

  Object.defineProperty(root, "clientWidth", { configurable: true, value: 640 });
  Object.defineProperty(editorRoot, "clientWidth", { configurable: true, value: 640 });
  Object.defineProperty(previewBody, "clientWidth", { configurable: true, value: 640 });

  return {
    root,
    previewBody,
    editorRoot,
    language: "mermaid",
    source,
    token: 1,
    preserveCurrent: options.preserveCurrent ?? false,
    isCurrent: options.isCurrent ?? (() => true),
    lockHeight: () => {
      previewBody.dataset.kukuCodeBlockHeightLocked = "";
      return () => {
        delete previewBody.dataset.kukuCodeBlockHeightLocked;
      };
    },
  };
}

describe("mermaid code block preview renderer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearMermaidRenderQueue();
    clearMermaidPreviewRuntimeCache();
    document.body.innerHTML = "";
    document.documentElement.removeAttribute("data-theme");
    Object.defineProperty(window, "requestAnimationFrame", {
      configurable: true,
      value: (callback: FrameRequestCallback): number => {
        callback(0);
        return 1;
      },
    });
  });

  it("matches mermaid code fence language aliases", () => {
    expect(mermaidCodeBlockPreviewRenderer.matches("mermaid")).toBe(true);
    expect(mermaidCodeBlockPreviewRenderer.matches("mmd")).toBe(true);
    expect(mermaidCodeBlockPreviewRenderer.matches("MERMAID")).toBe(true);
    expect(mermaidCodeBlockPreviewRenderer.deferUntilVisible).not.toBe(true);
    expect(mermaidCodeBlockPreviewRenderer.deferThemeRefreshUntilVisible).toBe(true);
    expect(mermaidCodeBlockPreviewRenderer.preserveScrollAnchorOnRender).toBe(true);
    expect(mermaidCodeBlockPreviewRenderer.reserveEstimatedHeight).toBe(true);
  });

  it("does not match unrelated code fence languages", () => {
    expect(mermaidCodeBlockPreviewRenderer.matches("typescript")).toBe(false);
    expect(mermaidCodeBlockPreviewRenderer.matches("")).toBe(false);
  });

  it("renders an empty diagram placeholder without loading mermaid", async () => {
    const ctx = createRenderContext("");

    await mermaidCodeBlockPreviewRenderer.render(ctx);

    expect(ctx.previewBody.dataset.kukuCodeBlockMermaidPlaceholder).toBe("");
    expect(ctx.previewBody.textContent).toBe("Empty Mermaid diagram");
    expect(mermaid.render).not.toHaveBeenCalled();
  });

  it("renders svg output into the preview body", async () => {
    vi.mocked(mermaid.render).mockResolvedValue({
      svg: '<svg role="img"><text>diagram</text></svg>',
      bindFunctions: undefined,
    } as Awaited<ReturnType<typeof mermaid.render>>);
    const ctx = createRenderContext("graph TD\nA-->B");

    await mermaidCodeBlockPreviewRenderer.render(ctx);

    expect(mermaid.initialize).toHaveBeenCalled();
    expect(mermaid.render).toHaveBeenCalledWith(
      expect.stringMatching(/^kuku-editor-mermaid-\d+$/),
      "graph TD\nA-->B",
      expect.any(HTMLElement),
    );
    expect(ctx.previewBody.dataset.kukuCodeBlockMermaidSvg).toBe("");
    expect(ctx.previewBody.dataset.kukuCodeBlockMermaidError).toBeUndefined();
    expect(ctx.previewBody.innerHTML).toContain("<svg");
  });

  it("reuses cached svg when a preview is recreated", async () => {
    vi.mocked(mermaid.render).mockResolvedValue({
      svg: '<svg role="img"><text>cached diagram</text></svg>',
      bindFunctions: undefined,
    } as Awaited<ReturnType<typeof mermaid.render>>);

    const first = createRenderContext("graph TD\nA-->B");
    await mermaidCodeBlockPreviewRenderer.render(first);

    const second = createRenderContext("graph TD\nA-->B");
    await mermaidCodeBlockPreviewRenderer.render(second);

    expect(mermaid.render).toHaveBeenCalledTimes(1);
    expect(second.previewBody.dataset.kukuCodeBlockMermaidSvg).toBe("");
    expect(second.previewBody.innerHTML).toContain("cached diagram");
  });

  it("does not share svg ids across cached preview instances", async () => {
    vi.mocked(mermaid.render).mockResolvedValue({
      svg: [
        '<svg id="diagram" role="img" aria-labelledby="label">',
        "<style>#diagram .edge{marker-end:url(#arrow)}</style>",
        '<defs><marker id="arrow"></marker></defs>',
        '<title id="label">cached diagram</title>',
        '<path class="edge" marker-end="url(#arrow)"></path>',
        '<use href="#arrow"></use>',
        "</svg>",
      ].join(""),
      bindFunctions: undefined,
    } as Awaited<ReturnType<typeof mermaid.render>>);

    const first = createRenderContext("graph TD\nA-->B");
    await mermaidCodeBlockPreviewRenderer.render(first);
    const second = createRenderContext("graph TD\nA-->B");
    await mermaidCodeBlockPreviewRenderer.render(second);

    expect(mermaid.render).toHaveBeenCalledTimes(1);

    const firstSvg = first.previewBody.querySelector("svg");
    const secondSvg = second.previewBody.querySelector("svg");
    const secondMarker = second.previewBody.querySelector("marker");
    const secondTitle = second.previewBody.querySelector("title");
    const secondPath = second.previewBody.querySelector("path");
    const secondUse = second.previewBody.querySelector("use");
    const secondStyle = second.previewBody.querySelector("style");
    const ids = [...document.querySelectorAll("[id]")].map((element) => element.id);

    expect(firstSvg?.id).toBeTruthy();
    expect(secondSvg?.id).toBeTruthy();
    expect(firstSvg?.id).not.toBe(secondSvg?.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(secondSvg?.getAttribute("aria-labelledby")).toBe(secondTitle?.id);
    expect(secondPath?.getAttribute("marker-end")).toBe(`url(#${secondMarker?.id})`);
    expect(secondUse?.getAttribute("href")).toBe(`#${secondMarker?.id}`);
    expect(secondStyle?.textContent).toContain(`#${secondSvg?.id}`);
    expect(secondStyle?.textContent).toContain(`url(#${secondMarker?.id})`);
  });

  it("does not reuse cached svg after the theme changes", async () => {
    vi.mocked(mermaid.render)
      .mockResolvedValueOnce({
        svg: '<svg role="img"><text>dark diagram</text></svg>',
        bindFunctions: undefined,
      } as Awaited<ReturnType<typeof mermaid.render>>)
      .mockResolvedValueOnce({
        svg: '<svg role="img"><text>light diagram</text></svg>',
        bindFunctions: undefined,
      } as Awaited<ReturnType<typeof mermaid.render>>);

    const dark = createRenderContext("graph TD\nA-->B");
    await mermaidCodeBlockPreviewRenderer.render(dark);

    document.documentElement.dataset.theme = "light";
    const light = createRenderContext("graph TD\nA-->B");
    await mermaidCodeBlockPreviewRenderer.render(light);

    expect(mermaid.render).toHaveBeenCalledTimes(2);
    expect(light.previewBody.innerHTML).toContain("light diagram");
  });

  it("uses the rendered height cache for later estimates", async () => {
    vi.mocked(mermaid.render).mockResolvedValue({
      svg: '<svg role="img"><text>diagram</text></svg>',
      bindFunctions: undefined,
    } as Awaited<ReturnType<typeof mermaid.render>>);
    const ctx = createRenderContext("graph TD\nA-->B");
    Object.defineProperty(ctx.previewBody, "offsetHeight", { configurable: true, value: 360 });

    await mermaidCodeBlockPreviewRenderer.render(ctx);

    expect(
      mermaidCodeBlockPreviewRenderer.estimateHeight?.({
        root: ctx.root,
        editorRoot: ctx.editorRoot,
        language: ctx.language,
        source: ctx.source,
        width: 640,
      }),
    ).toBe(360);
  });

  it("changes preview cache signature when width or theme changes", () => {
    const ctx = createRenderContext("graph TD\nA-->B");
    const base = mermaidCodeBlockPreviewRenderer.getCacheSignature?.({
      root: ctx.root,
      editorRoot: ctx.editorRoot,
      language: ctx.language,
      source: ctx.source,
      width: 1280,
    });
    const wider = mermaidCodeBlockPreviewRenderer.getCacheSignature?.({
      root: ctx.root,
      editorRoot: ctx.editorRoot,
      language: ctx.language,
      source: ctx.source,
      width: 1536,
    });

    document.documentElement.dataset.theme = "light";
    const light = mermaidCodeBlockPreviewRenderer.getCacheSignature?.({
      root: ctx.root,
      editorRoot: ctx.editorRoot,
      language: ctx.language,
      source: ctx.source,
      width: 1280,
    });

    expect(base).toBeTruthy();
    expect(wider).not.toBe(base);
    expect(light).not.toBe(base);
  });

  it("renders Mermaid errors as preview text", async () => {
    vi.mocked(mermaid.render).mockRejectedValue(new Error("bad diagram"));
    const ctx = createRenderContext("graph TD\nA-->");

    await mermaidCodeBlockPreviewRenderer.render(ctx);

    expect(ctx.previewBody.dataset.kukuCodeBlockMermaidSvg).toBeUndefined();
    expect(ctx.previewBody.dataset.kukuCodeBlockMermaidError).toBe("");
    expect(ctx.previewBody.textContent).toBe("bad diagram");
  });

  it("preserves the current svg when a refresh render fails", async () => {
    vi.mocked(mermaid.render).mockRejectedValue(new Error("bad diagram"));
    const ctx = createRenderContext("graph TD\nA-->", { preserveCurrent: true });
    ctx.previewBody.dataset.kukuCodeBlockMermaidSvg = "";
    ctx.previewBody.innerHTML = '<svg role="img"><text>old diagram</text></svg>';

    await mermaidCodeBlockPreviewRenderer.render(ctx);

    expect(ctx.previewBody.dataset.kukuCodeBlockMermaidSvg).toBe("");
    expect(ctx.previewBody.dataset.kukuCodeBlockMermaidError).toBeUndefined();
    expect(ctx.previewBody.innerHTML).toContain("old diagram");
    expect(ctx.previewBody.dataset.kukuCodeBlockHeightLocked).toBeUndefined();
  });
});
