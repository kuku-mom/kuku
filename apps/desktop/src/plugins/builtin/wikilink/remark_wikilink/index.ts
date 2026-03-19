import type { Extension as FromMarkdownExtension } from "mdast-util-from-markdown";
import type { Options as ToMarkdownExtension } from "mdast-util-to-markdown";
import type { Extension as MicromarkExtension } from "micromark-util-types";

import { fromMarkdown } from "./from_markdown";
import { syntax } from "./syntax";
import { toMarkdown } from "./to_markdown";
import "./types";

interface RemarkData {
  micromarkExtensions?: MicromarkExtension[];
  fromMarkdownExtensions?: FromMarkdownExtension[];
  toMarkdownExtensions?: ToMarkdownExtension[];
}

function applyRemarkWikilink(this: { data(): unknown }): void {
  const data = this.data() as RemarkData & Record<string, unknown>;

  data.micromarkExtensions ??= [];
  data.fromMarkdownExtensions ??= [];
  data.toMarkdownExtensions ??= [];

  data.micromarkExtensions.push(syntax());
  data.fromMarkdownExtensions.push(fromMarkdown());
  data.toMarkdownExtensions.push(toMarkdown());
}

const remarkWikilink = applyRemarkWikilink;

export { remarkWikilink };
export type { WikiLink } from "./types";
