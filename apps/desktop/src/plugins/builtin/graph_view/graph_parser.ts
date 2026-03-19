import type { Root } from "mdast";

import { createProcessor } from "~/lib/markdown";

import { remarkWikilink } from "~/plugins/builtin/wikilink/remark_wikilink";

export interface GraphParser {
  parse(source: string): Root;
}

export function createGraphParser(): GraphParser {
  const processor = createProcessor({
    remarkPlugins: [remarkWikilink],
  });

  return {
    parse(source: string): Root {
      return processor.parse(source);
    },
  };
}
