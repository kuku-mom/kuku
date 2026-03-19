import type { Paragraph, Root } from "mdast";

import { describe, expect, it } from "vitest";

import { createProcessor } from "~/lib/markdown";

import { remarkWikilink } from "../remark_wikilink";
import type { WikiLink } from "../remark_wikilink/types";

function createParser() {
  const processor = createProcessor({
    remarkPlugins: [remarkWikilink],
  });
  return {
    parse(source: string): Root {
      return processor.parse(source);
    },
  };
}

function firstParagraph(tree: Root): Paragraph | undefined {
  const paragraph = tree.children[0];
  return paragraph?.type === "paragraph" ? paragraph : undefined;
}

function firstWikilink(tree: Root): WikiLink | undefined {
  return firstParagraph(tree)?.children.find(
    (child): child is WikiLink => child.type === "wikilink",
  );
}

function allWikilinks(tree: Root): WikiLink[] {
  const results: WikiLink[] = [];

  for (const child of tree.children) {
    if (child.type !== "paragraph") continue;
    for (const inline of child.children) {
      if (inline.type === "wikilink") {
        results.push(inline);
      }
    }
  }

  return results;
}

describe("wikilink parser", () => {
  const parser = createParser();

  it("parses [[target]]", () => {
    const tree = parser.parse("[[Page Name]]");
    const node = firstWikilink(tree);

    expect(node).toBeDefined();
    expect(node?.type).toBe("wikilink");
    expect(node?.target).toBe("Page Name");
    expect(node?.alias).toBeUndefined();
    expect(node?.value).toBe("Page Name");
  });

  it("parses [[target|alias]]", () => {
    const tree = parser.parse("[[Page Name|display text]]");
    const node = firstWikilink(tree);

    expect(node).toBeDefined();
    expect(node?.target).toBe("Page Name");
    expect(node?.alias).toBe("display text");
    expect(node?.value).toBe("display text");
  });

  it("parses multiple wikilinks in one paragraph", () => {
    const tree = parser.parse("[[first]] and [[second|alias]]");
    const links = allWikilinks(tree);

    expect(links).toHaveLength(2);
    expect(links[0].target).toBe("first");
    expect(links[1].target).toBe("second");
    expect(links[1].alias).toBe("alias");
  });

  it("ignores invalid single brackets", () => {
    const tree = parser.parse("[not a wikilink]");
    expect(allWikilinks(tree)).toHaveLength(0);
  });

  it("rejects empty target and alias forms", () => {
    expect(allWikilinks(parser.parse("[[]]"))).toHaveLength(0);
    expect(allWikilinks(parser.parse("[[|alias]]"))).toHaveLength(0);
    expect(allWikilinks(parser.parse("[[target|]]"))).toHaveLength(0);
  });

  it("rejects line breaks and unclosed patterns", () => {
    expect(allWikilinks(parser.parse("[[broken\nlink]]"))).toHaveLength(0);
    expect(allWikilinks(parser.parse("[[target"))).toHaveLength(0);
    expect(allWikilinks(parser.parse("[[target]"))).toHaveLength(0);
  });
});
