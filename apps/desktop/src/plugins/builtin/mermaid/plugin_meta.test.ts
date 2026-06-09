import highlighter from "highlight.js";
import { describe, expect, it } from "vitest";

import { mermaidPlugin } from "./index";

describe("mermaid plugin metadata", () => {
  it("keeps Mermaid syntax highlighting available when diagram rendering is disableable", () => {
    expect(mermaidPlugin.canDisable).toBe(true);
    expect(highlighter.getLanguage("mermaid")).toBeTruthy();
    expect(highlighter.getLanguage("mmd")).toBeTruthy();
  });
});
