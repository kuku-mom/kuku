import { describe, expect, it } from "vitest";

import { parseMarkdownLinkLikeSyntax } from "../markdown_input";

describe("parseMarkdownLinkLikeSyntax", () => {
  it("parses a simple link", () => {
    expect(parseMarkdownLinkLikeSyntax("[text](https://example.com)", { image: false })).toEqual({
      label: "text",
      target: "https://example.com",
    });
  });

  it("parses a simple image", () => {
    expect(
      parseMarkdownLinkLikeSyntax("![alt text](https://example.com/img.png)", { image: true }),
    ).toEqual({
      label: "alt text",
      target: "https://example.com/img.png",
    });
  });

  it("parses an empty link label", () => {
    expect(
      parseMarkdownLinkLikeSyntax("[](https://example.com)", {
        image: false,
        allowEmptyLabel: true,
      }),
    ).toEqual({
      label: "",
      target: "https://example.com",
    });
  });

  it("parses an empty image alt", () => {
    expect(
      parseMarkdownLinkLikeSyntax("![](https://example.com/img.png)", {
        image: true,
        allowEmptyLabel: true,
      }),
    ).toEqual({
      label: "",
      target: "https://example.com/img.png",
    });
  });

  it("supports nested brackets in the label", () => {
    expect(
      parseMarkdownLinkLikeSyntax("![something[__link__]](https://example.com/img.png)", {
        image: true,
      }),
    ).toEqual({
      label: "something[__link__]",
      target: "https://example.com/img.png",
    });
  });

  it("rejects malformed bracket pairs", () => {
    expect(
      parseMarkdownLinkLikeSyntax("![something[__link__](https://example.com)", {
        image: true,
      }),
    ).toBeNull();
  });

  it("rejects targets with whitespace", () => {
    expect(parseMarkdownLinkLikeSyntax("[text](https://example.com title)", { image: false })).toBe(
      null,
    );
  });
});
