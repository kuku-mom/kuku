import { describe, expect, it } from "vitest";

import { createLigatureWidgetDecoration, LIGATURES } from "./rules";

describe("typography ligature widgets", () => {
  it("creates equivalent widget decorations across rebuilds", () => {
    const ligature = LIGATURES.find(({ pattern }) => pattern === "->");
    if (!ligature) throw new Error("expected ligature for '->'");

    const first = createLigatureWidgetDecoration(12, ligature);
    const second = createLigatureWidgetDecoration(12, ligature);

    expect((first as unknown as { eq(other: unknown): boolean }).eq(second)).toBe(true);
  });

  it("keeps different ligatures distinct", () => {
    const rightArrow = LIGATURES.find(({ pattern }) => pattern === "->");
    const leftArrow = LIGATURES.find(({ pattern }) => pattern === "<-");
    if (!rightArrow) throw new Error("expected ligature for '->'");
    if (!leftArrow) throw new Error("expected ligature for '<-'");

    const first = createLigatureWidgetDecoration(12, rightArrow);
    const second = createLigatureWidgetDecoration(12, leftArrow);

    expect((first as unknown as { eq(other: unknown): boolean }).eq(second)).toBe(false);
  });
});
