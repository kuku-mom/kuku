import highlighter from "highlight.js";
import { describe, expect, it } from "vitest";

import { mermaidPreviewPlugin } from "./index";

describe("mermaid preview plugin metadata", () => {
  it("keeps Mermaid syntax highlighting available when diagram rendering is disableable", () => {
    expect(mermaidPreviewPlugin.id).toBe("mermaid-preview");
    expect(mermaidPreviewPlugin.name).toBe("Mermaid Preview");
    expect(mermaidPreviewPlugin.canDisable).toBe(true);
    expect(highlighter.getLanguage("mermaid")).toBeTruthy();
    expect(highlighter.getLanguage("mmd")).toBeTruthy();
  });
});
