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
    expect(mermaidCodeBlockPreviewRenderer.deferUntilVisible).toBe(true);
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
