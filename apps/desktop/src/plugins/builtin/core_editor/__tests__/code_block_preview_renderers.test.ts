import { afterEach, describe, expect, it } from "vitest";

import {
  clearCodeBlockPreviewRenderersForTest,
  listCodeBlockPreviewRenderers,
  normalizeCodeBlockLanguage,
  registerCodeBlockPreviewRenderer,
  resolveCodeBlockPreviewRenderer,
  type CodeBlockPreviewRenderer,
} from "../code_block_preview_renderers";

function renderer(id: string, languages: readonly string[]): CodeBlockPreviewRenderer {
  return {
    id,
    matches: (language) => languages.includes(language),
    render: () => undefined,
  };
}

describe("code block preview renderers", () => {
  afterEach(() => {
    clearCodeBlockPreviewRenderersForTest();
  });

  it("normalizes language names for renderer lookup", () => {
    expect(normalizeCodeBlockLanguage(" Mermaid ")).toBe("mermaid");
    expect(normalizeCodeBlockLanguage("MMD")).toBe("mmd");
  });

  it("does not resolve renderers for blank languages", () => {
    registerCodeBlockPreviewRenderer(renderer("mermaid", ["mermaid"]));

    expect(resolveCodeBlockPreviewRenderer(" ")).toBeNull();
  });

  it("resolves the first matching renderer in registration order", () => {
    const first = renderer("first", ["mermaid"]);
    const second = renderer("second", ["mermaid"]);

    registerCodeBlockPreviewRenderer(first);
    registerCodeBlockPreviewRenderer(second);

    expect(resolveCodeBlockPreviewRenderer("MERMAID")).toBe(first);
    expect(listCodeBlockPreviewRenderers()).toEqual([first, second]);
  });

  it("unregisters a renderer through its disposer", () => {
    const first = renderer("first", ["mermaid"]);
    const second = renderer("second", ["mmd"]);

    const disposeFirst = registerCodeBlockPreviewRenderer(first);
    registerCodeBlockPreviewRenderer(second);
    disposeFirst();

    expect(resolveCodeBlockPreviewRenderer("mermaid")).toBeNull();
    expect(resolveCodeBlockPreviewRenderer("mmd")).toBe(second);
    expect(listCodeBlockPreviewRenderers()).toEqual([second]);
  });

  it("keeps replacement registrations isolated from stale disposers", () => {
    const original = renderer("mermaid", ["mermaid"]);
    const replacement = renderer("mermaid", ["mmd"]);

    const disposeOriginal = registerCodeBlockPreviewRenderer(original);
    registerCodeBlockPreviewRenderer(replacement);
    disposeOriginal();

    expect(resolveCodeBlockPreviewRenderer("mermaid")).toBeNull();
    expect(resolveCodeBlockPreviewRenderer("mmd")).toBe(replacement);
  });

  it("preserves scheduling hints on renderer entries", () => {
    const hinted: CodeBlockPreviewRenderer = {
      ...renderer("hinted", ["mermaid"]),
      deferUntilVisible: true,
      deferThemeRefreshUntilVisible: true,
      estimateHeight: () => 240,
      preserveScrollAnchorOnRender: true,
      reserveEstimatedHeight: true,
    };

    registerCodeBlockPreviewRenderer(hinted);

    expect(resolveCodeBlockPreviewRenderer("mermaid")).toBe(hinted);
    expect(listCodeBlockPreviewRenderers()).toEqual([hinted]);
  });

  it("rejects blank renderer ids", () => {
    expect(() => registerCodeBlockPreviewRenderer(renderer(" ", ["mermaid"]))).toThrow(
      "Code block preview renderer id is required.",
    );
  });
});
