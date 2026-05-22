import { renderToString } from "solid-js/web";
import { describe, expect, it } from "vitest";

import CodeBlockNode from "./code_block_node";

describe("CodeBlockNode", () => {
  it("renders editable markdown fences around the code content", () => {
    const html = renderToString(() =>
      CodeBlockNode({
        contentRef: () => undefined,
        node: { attrs: { language: "mermaid" } },
        setAttrs: () => undefined,
      } as never),
    );

    expect(html).toContain("data-kuku-code-block");
    expect(html).toContain("data-kuku-code-block-opening-fence");
    expect(html).toContain("data-kuku-code-block-opening-input");
    expect(html).toContain('value="```mermaid"');
    expect(html).toContain("data-kuku-code-block-closing-fence");
    expect(html).toContain("data-kuku-code-block-closing-input");
    expect(html).toContain('value="```"');
  });

  it("renders a mermaid preview container for mermaid code blocks", () => {
    const html = renderToString(() =>
      CodeBlockNode({
        contentRef: () => undefined,
        node: {
          attrs: { language: "mermaid" },
          textContent: "flowchart LR\n  A --> B",
        },
        setAttrs: () => undefined,
      } as never),
    );

    expect(html).toContain("data-kuku-code-block-mermaid-preview");
  });
});
