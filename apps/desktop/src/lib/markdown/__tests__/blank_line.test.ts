/**
 * Blank-Line Preservation Tests
 *
 * Verifies that extra blank lines survive the full round-trip:
 *
 *   markdown (::br) → mdast → PM JSON (empty paragraphs)
 *                    ↕ MarkdownService.parse / stringify ↕
 *   PM JSON (empty paragraphs) → mdast → markdown (::br)
 *
 * The conversion is transparent to the editor — ProseMirror only sees
 * normal empty paragraphs.  The `::br` leaf directive (remark-directive)
 * is used solely as a persistence format.
 */

import { beforeAll, describe, expect, it } from "vitest";

import type { PMNodeJSON } from "~/lib/markdown";
import { editorCoreMarkdown } from "~/plugins/builtin/core_editor/markdown_handlers";
import {
  type MarkdownService,
  buildMarkdownService,
  contributeMarkdown,
  getMarkdownService,
} from "~/plugins/markdown_service";

// ── Setup ──

let md: MarkdownService;

beforeAll(() => {
  contributeMarkdown("core-editor", editorCoreMarkdown);
  buildMarkdownService();
  const svc = getMarkdownService();
  if (!svc) throw new Error("MarkdownService not built");
  md = svc;
});

// ── Helpers ──

function textParagraph(text: string): PMNodeJSON {
  return { type: "paragraph", content: [{ type: "text", text }] };
}

const emptyParagraph: PMNodeJSON = { type: "paragraph" };

function doc(...content: PMNodeJSON[]): PMNodeJSON {
  return { type: "doc", content };
}

/** Trim trailing whitespace for easier comparison. */
function trim(s: string): string {
  return s.trimEnd();
}

// ── Tests ──

describe("Blank line preservation (::br directive)", () => {
  // ── Parse (markdown → PM) ──

  describe("parse", () => {
    it("::br between paragraphs becomes an empty paragraph", () => {
      const pm = md.parse("Hello\n\n::br\n\nWorld");

      expect(pm).toEqual(doc(textParagraph("Hello"), emptyParagraph, textParagraph("World")));
    });

    it("multiple ::br directives become multiple empty paragraphs", () => {
      const pm = md.parse("Hello\n\n::br\n\n::br\n\nWorld");

      expect(pm).toEqual(
        doc(textParagraph("Hello"), emptyParagraph, emptyParagraph, textParagraph("World")),
      );
    });

    it("::br at the start of a document", () => {
      const pm = md.parse("::br\n\nHello");

      expect(pm).toEqual(doc(emptyParagraph, textParagraph("Hello")));
    });

    it("::br at the end of a document", () => {
      const pm = md.parse("Hello\n\n::br");

      expect(pm).toEqual(doc(textParagraph("Hello"), emptyParagraph));
    });

    it("markdown without ::br is unaffected", () => {
      const pm = md.parse("Hello\n\nWorld");

      expect(pm).toEqual(doc(textParagraph("Hello"), textParagraph("World")));
    });
  });

  // ── Stringify (PM → markdown) ──

  describe("stringify", () => {
    it("empty paragraph between text becomes ::br", () => {
      const result = md.stringify(
        doc(textParagraph("Hello"), emptyParagraph, textParagraph("World")),
      );

      expect(trim(result)).toBe("Hello\n\n::br\n\nWorld");
    });

    it("multiple empty paragraphs become multiple ::br", () => {
      const result = md.stringify(
        doc(textParagraph("Hello"), emptyParagraph, emptyParagraph, textParagraph("World")),
      );

      expect(trim(result)).toBe("Hello\n\n::br\n\n::br\n\nWorld");
    });

    it("normal paragraphs do not produce ::br", () => {
      const result = md.stringify(doc(textParagraph("Hello"), textParagraph("World")));

      expect(result).not.toContain("::br");
      expect(trim(result)).toBe("Hello\n\nWorld");
    });

    it("empty paragraph at the end", () => {
      const result = md.stringify(doc(textParagraph("Hello"), emptyParagraph));

      expect(trim(result)).toBe("Hello\n\n::br");
    });
  });

  // ── Round-trip ──

  describe("round-trip", () => {
    it("single ::br survives round-trip", () => {
      const input = "Hello\n\n::br\n\nWorld";
      const pm = md.parse(input);
      const output = trim(md.stringify(pm));

      expect(output).toBe(input);
    });

    it("multiple ::br survive round-trip", () => {
      const input = "Hello\n\n::br\n\n::br\n\n::br\n\nWorld";
      const pm = md.parse(input);
      const output = trim(md.stringify(pm));

      expect(output).toBe(input);
    });

    it("document without ::br is stable", () => {
      const input = "Hello\n\nWorld";
      const pm = md.parse(input);
      const output = trim(md.stringify(pm));

      expect(output).toBe(input);
    });

    it("double round-trip is idempotent", () => {
      const input = "First\n\n::br\n\nSecond\n\nThird";

      const pm1 = md.parse(input);
      const md1 = md.stringify(pm1);

      const pm2 = md.parse(md1);
      const md2 = md.stringify(pm2);

      expect(md2).toBe(md1);
    });
  });
});
