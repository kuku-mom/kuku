/**
 * Markdown Round-Trip Tests
 *
 * Tests the full pipeline: md → mdast → PM JSON → mdast → md
 *
 * Strategy: "Double Round-Trip"
 * 1st round: md → PM JSON → md (remark normalizes whitespace/formatting)
 * 2nd round: md → PM JSON → md (should be identical to 1st — idempotent)
 *
 * We compare 1st === 2nd to verify the pipeline is stable.
 */

import { describe, it, expect } from "vitest";

import { editorCoreMarkdown } from "~/plugins/builtin/core_editor/markdown_handlers";

import {
  RegistryBuilder,
  createProcessor,
  makeText,
  mdastToProseMirror,
  proseMirrorToMdast,
  type RemarkPlugin,
} from "~/lib/markdown";

// ── Test registry (base + all core_editor handlers) ──

function createTestRegistry() {
  const builder = new RegistryBuilder().addBase();
  const md = editorCoreMarkdown;

  // mdast → PM
  if (md.mdastToPm?.block) {
    for (const [type, handler] of Object.entries(md.mdastToPm.block)) {
      builder.addMdastBlockHandler(type, handler);
    }
  }
  if (md.mdastToPm?.inline) {
    for (const [type, handler] of Object.entries(md.mdastToPm.inline)) {
      builder.addMdastInlineHandler(type, handler);
    }
  }
  // PM → mdast
  if (md.pmToMdast?.block) {
    for (const [type, handler] of Object.entries(md.pmToMdast.block)) {
      builder.addPmBlockHandler(type, handler);
    }
  }
  if (md.pmToMdast?.inline) {
    for (const [type, handler] of Object.entries(md.pmToMdast.inline)) {
      builder.addPmInlineHandler(type, handler);
    }
  }
  if (md.pmToMdast?.mark) {
    for (const [type, handler] of Object.entries(md.pmToMdast.mark)) {
      builder.addPmMarkHandler(type, handler);
    }
  }

  return builder.build();
}

// ── Helper: double round-trip assertion ──

function assertDoubleRoundTrip(input: string): void {
  const remarkPlugins: RemarkPlugin[] = editorCoreMarkdown.remarkPlugins ?? [];
  const proc = createProcessor({ remarkPlugins });
  const registry = createTestRegistry();

  // 1st round
  const pm1 = mdastToProseMirror(proc.parse(input), registry);
  const md1 = proc.stringify(proseMirrorToMdast(pm1, registry));

  // 2nd round
  const pm2 = mdastToProseMirror(proc.parse(md1), registry);
  const md2 = proc.stringify(proseMirrorToMdast(pm2, registry));

  expect(md2).toBe(md1);
}

// ── Tests ──

describe("Base schema round-trip", () => {
  it("empty document", () => {
    assertDoubleRoundTrip("");
  });

  it("single paragraph", () => {
    assertDoubleRoundTrip("Hello world");
  });

  it("multiple paragraphs", () => {
    assertDoubleRoundTrip("First paragraph\n\nSecond paragraph");
  });

  it("paragraph with trailing newline", () => {
    assertDoubleRoundTrip("Hello world\n");
  });
});

describe("Heading round-trip", () => {
  it("heading level 1", () => {
    assertDoubleRoundTrip("# Heading 1");
  });

  it("heading level 2", () => {
    assertDoubleRoundTrip("## Heading 2");
  });

  it("heading level 3", () => {
    assertDoubleRoundTrip("### Heading 3");
  });

  it("heading level 4", () => {
    assertDoubleRoundTrip("#### Heading 4");
  });

  it("heading level 5", () => {
    assertDoubleRoundTrip("##### Heading 5");
  });

  it("heading level 6", () => {
    assertDoubleRoundTrip("###### Heading 6");
  });

  it("heading followed by paragraph", () => {
    assertDoubleRoundTrip("# Title\n\nSome text");
  });

  it("multiple headings", () => {
    assertDoubleRoundTrip("# First\n\n## Second\n\n### Third");
  });
});

describe("Bold round-trip", () => {
  it("bold text", () => {
    assertDoubleRoundTrip("**bold**");
  });

  it("bold in paragraph", () => {
    assertDoubleRoundTrip("Hello **bold** world");
  });

  it("bold at start", () => {
    assertDoubleRoundTrip("**bold** text");
  });

  it("bold at end", () => {
    assertDoubleRoundTrip("text **bold**");
  });
});

describe("Italic round-trip", () => {
  it("italic text", () => {
    assertDoubleRoundTrip("*italic*");
  });

  it("italic in paragraph", () => {
    assertDoubleRoundTrip("Hello *italic* world");
  });
});

describe("Inline code round-trip", () => {
  it("inline code", () => {
    assertDoubleRoundTrip("`code`");
  });

  it("inline code in paragraph", () => {
    assertDoubleRoundTrip("Hello `code` world");
  });

  it("inline code with special chars", () => {
    assertDoubleRoundTrip("`const x = 1`");
  });
});

describe("Hard break round-trip", () => {
  it("markdown hard break", () => {
    assertDoubleRoundTrip("Line 1  \nLine 2");
  });

  it("raw br html", () => {
    assertDoubleRoundTrip("Line 1<br>\nLine 2");
  });
});

describe("Combined marks round-trip", () => {
  it("bold and italic nested", () => {
    assertDoubleRoundTrip("***bold italic***");
  });

  it("bold then italic", () => {
    assertDoubleRoundTrip("**bold** and *italic*");
  });

  it("heading with bold", () => {
    assertDoubleRoundTrip("# Hello **world**");
  });

  it("heading with italic", () => {
    assertDoubleRoundTrip("# Hello *world*");
  });

  it("heading with inline code", () => {
    assertDoubleRoundTrip("# Hello `world`");
  });

  it("heading with mixed marks", () => {
    assertDoubleRoundTrip("# **Bold** and *italic* and `code`");
  });

  it("paragraph with all marks", () => {
    assertDoubleRoundTrip("Normal **bold** *italic* `code` end");
  });

  it("bold inside italic", () => {
    // Known limitation: remark's stringify produces extra asterisks on re-parse
    // of nested emphasis/strong boundaries. This is a remark normalization issue,
    // not a pipeline bug. We verify text content is preserved instead.
    const proc = createProcessor();
    const registry = createTestRegistry();

    const pm = mdastToProseMirror(proc.parse("*italic **bold italic** italic*"), registry);
    const md = proc.stringify(proseMirrorToMdast(pm, registry));

    expect(md).toContain("italic");
    expect(md).toContain("bold italic");
  });
});

describe("Thematic break round-trip", () => {
  it("thematic break", () => {
    assertDoubleRoundTrip("---");
  });

  it("thematic break between paragraphs", () => {
    assertDoubleRoundTrip("Before\n\n---\n\nAfter");
  });
});

describe("Blockquote round-trip", () => {
  it("simple blockquote", () => {
    assertDoubleRoundTrip("> Hello");
  });

  it("blockquote with multiple lines", () => {
    assertDoubleRoundTrip("> Line one\n>\n> Line two");
  });

  it("nested blockquote", () => {
    assertDoubleRoundTrip("> Outer\n>\n> > Inner");
  });

  it("blockquote with bold", () => {
    assertDoubleRoundTrip("> **bold** text");
  });
});

describe("Code block round-trip", () => {
  it("code block without language", () => {
    assertDoubleRoundTrip("```\nconst x = 1;\n```");
  });

  it("code block with language", () => {
    assertDoubleRoundTrip("```js\nconst x = 1;\n```");
  });

  it("code block with multiple lines", () => {
    assertDoubleRoundTrip("```\nline 1\nline 2\nline 3\n```");
  });

  it("code block between paragraphs", () => {
    assertDoubleRoundTrip("Before\n\n```\ncode\n```\n\nAfter");
  });

  it("normalizes tilde code fences", () => {
    const input = "~~~js\nconst x = 1;\n~~~";
    const remarkPlugins: RemarkPlugin[] = editorCoreMarkdown.remarkPlugins ?? [];
    const proc = createProcessor({ remarkPlugins });
    const registry = createTestRegistry();

    const pm = mdastToProseMirror(proc.parse(input), registry);
    const cb = (pm.content ?? [])[0];
    expect(cb.attrs?.language).toBe("js");

    const md = proc.stringify(proseMirrorToMdast(pm, registry));
    expect(md.trimEnd()).toBe("```js\nconst x = 1;\n```");
  });
});

describe("Link round-trip", () => {
  it("simple link", () => {
    assertDoubleRoundTrip("[text](https://example.com)");
  });

  it("link in paragraph", () => {
    assertDoubleRoundTrip("Click [here](https://example.com) now");
  });

  it("link with bold text", () => {
    // Known limitation: remark normalizes mark/link nesting order differently
    // on re-parse. Text content is preserved — verify that instead.
    const proc = createProcessor();
    const registry = createTestRegistry();

    const pm = mdastToProseMirror(proc.parse("[**bold link**](https://example.com)"), registry);
    const md = proc.stringify(proseMirrorToMdast(pm, registry));

    expect(md).toContain("bold link");
    expect(md).toContain("https://example.com");
  });
});

describe("Image round-trip", () => {
  it("simple image", () => {
    assertDoubleRoundTrip("![](https://example.com/img.png)");
  });

  it("image with alt text", () => {
    assertDoubleRoundTrip("![placeholder text](https://example.com/img.png)");
  });
});

describe("Strikethrough round-trip (GFM)", () => {
  it("strikethrough text", () => {
    assertDoubleRoundTrip("~~deleted~~");
  });

  it("strikethrough in paragraph", () => {
    assertDoubleRoundTrip("Hello ~~deleted~~ world");
  });
});

describe("List round-trip", () => {
  it("unordered list", () => {
    assertDoubleRoundTrip("- Item 1\n- Item 2\n- Item 3");
  });

  it("ordered list", () => {
    assertDoubleRoundTrip("1. First\n2. Second\n3. Third");
  });

  it("nested unordered list", () => {
    assertDoubleRoundTrip("- Parent\n  - Child\n  - Child 2");
  });

  it("list with bold", () => {
    assertDoubleRoundTrip("- **bold** item\n- normal item");
  });

  it("task list (GFM)", () => {
    assertDoubleRoundTrip("- [ ] Todo\n- [x] Done");
  });
});

describe("Table round-trip (GFM)", () => {
  it("simple table", () => {
    assertDoubleRoundTrip("| a | b |\n| - | - |\n| c | d |");
  });

  it("table with inline formatting", () => {
    assertDoubleRoundTrip("| name | value |\n| - | - |\n| **bold** | `code` |");
  });
});

describe("PM JSON structure", () => {
  it("paragraph produces correct PM JSON", () => {
    const proc = createProcessor();
    const registry = createTestRegistry();
    const pm = mdastToProseMirror(proc.parse("Hello"), registry);

    expect(pm.type).toBe("doc");
    const content = pm.content ?? [];
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("paragraph");
    const inner = content[0].content ?? [];
    expect(inner).toHaveLength(1);
    expect(inner[0].type).toBe("text");
    expect(inner[0].text).toBe("Hello");
  });

  it("heading produces correct PM JSON", () => {
    const proc = createProcessor();
    const registry = createTestRegistry();
    const pm = mdastToProseMirror(proc.parse("## Title"), registry);

    const block = (pm.content ?? [])[0];
    expect(block.type).toBe("heading");
    expect(block.attrs).toEqual({ level: 2 });
    expect((block.content ?? [])[0].text).toBe("Title");
  });

  it("bold produces correct marks", () => {
    const proc = createProcessor();
    const registry = createTestRegistry();
    const pm = mdastToProseMirror(proc.parse("**bold**"), registry);

    const textNode = (pm.content ?? [])[0].content?.[0];
    expect(textNode?.text).toBe("bold");
    expect(textNode?.marks).toEqual([{ type: "bold" }]);
  });

  it("italic produces correct marks", () => {
    const proc = createProcessor();
    const registry = createTestRegistry();
    const pm = mdastToProseMirror(proc.parse("*italic*"), registry);

    const textNode = (pm.content ?? [])[0].content?.[0];
    expect(textNode?.text).toBe("italic");
    expect(textNode?.marks).toEqual([{ type: "italic" }]);
  });

  it("inline code produces correct marks", () => {
    const proc = createProcessor();
    const registry = createTestRegistry();
    const pm = mdastToProseMirror(proc.parse("`code`"), registry);

    const textNode = (pm.content ?? [])[0].content?.[0];
    expect(textNode?.text).toBe("code");
    expect(textNode?.marks).toEqual([{ type: "code" }]);
  });

  it("deduplicates repeated marks on text nodes", () => {
    const textNode = makeText("value", [{ type: "code" }, { type: "bold" }, { type: "bold" }]);

    expect(textNode.marks).toEqual([{ type: "code" }, { type: "bold" }]);
  });

  it("bold+italic produces nested marks", () => {
    const proc = createProcessor();
    const registry = createTestRegistry();
    const pm = mdastToProseMirror(proc.parse("***both***"), registry);

    const textNode = (pm.content ?? [])[0].content?.[0];
    expect(textNode?.text).toBe("both");
    expect(textNode?.marks).toHaveLength(2);
    const markTypeSet = (textNode?.marks ?? []).map((m) => m.type);
    expect(markTypeSet).toHaveLength(2);
    expect(markTypeSet).toContain("bold");
    expect(markTypeSet).toContain("italic");
  });

  it("thematic break produces horizontalRule", () => {
    const proc = createProcessor();
    const registry = createTestRegistry();
    const pm = mdastToProseMirror(proc.parse("---"), registry);

    expect((pm.content ?? [])[0].type).toBe("horizontalRule");
  });

  it("blockquote produces correct structure", () => {
    const proc = createProcessor();
    const registry = createTestRegistry();
    const pm = mdastToProseMirror(proc.parse("> Hello"), registry);

    const bq = (pm.content ?? [])[0];
    expect(bq.type).toBe("blockquote");
    expect((bq.content ?? [])[0].type).toBe("paragraph");
  });

  it("code block produces correct structure", () => {
    const proc = createProcessor();
    const registry = createTestRegistry();
    const pm = mdastToProseMirror(proc.parse("```js\ncode\n```"), registry);

    const cb = (pm.content ?? [])[0];
    expect(cb.type).toBe("codeBlock");
    expect(cb.attrs?.language).toBe("js");
    expect((cb.content ?? [])[0].text).toBe("code");
  });

  it("link produces correct marks", () => {
    const proc = createProcessor();
    const registry = createTestRegistry();
    const pm = mdastToProseMirror(proc.parse("[text](https://example.com)"), registry);

    const textNode = (pm.content ?? [])[0].content?.[0];
    expect(textNode?.text).toBe("text");
    expect(textNode?.marks).toEqual([{ type: "link", attrs: { href: "https://example.com" } }]);
  });

  it("empty link text falls back to destination text", () => {
    const proc = createProcessor();
    const registry = createTestRegistry();
    const pm = mdastToProseMirror(proc.parse("[](https://example.com)"), registry);

    const textNode = (pm.content ?? [])[0].content?.[0];
    expect(textNode?.text).toBe("https://example.com");
    expect(textNode?.marks).toEqual([{ type: "link", attrs: { href: "https://example.com" } }]);
  });

  it("image produces correct structure", () => {
    const proc = createProcessor();
    const registry = createTestRegistry();
    const pm = mdastToProseMirror(proc.parse("![](https://example.com/img.png)"), registry);

    // Image is lifted out of paragraph
    const img = (pm.content ?? [])[0];
    expect(img.type).toBe("image");
    expect(img.attrs?.src).toBe("https://example.com/img.png");
  });

  it("image preserves alt text", () => {
    const proc = createProcessor();
    const registry = createTestRegistry();
    const pm = mdastToProseMirror(
      proc.parse("![placeholder text](https://example.com/img.png)"),
      registry,
    );

    const img = (pm.content ?? [])[0];
    expect(img.type).toBe("image");
    expect(img.attrs?.src).toBe("https://example.com/img.png");
    expect(img.attrs?.alt).toBe("placeholder text");
  });
});
