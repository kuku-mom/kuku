/**
 * mdast-util extension that serializes `WikiLink` AST nodes back into
 * wikilink markdown syntax during `toMarkdown` compilation.
 *
 * Serialization:
 *   { target: "Page", alias: undefined } → `[[Page]]`
 *   { target: "Page", alias: "display" } → `[[Page|display]]`
 */

import type { Parents } from "mdast";
import type { ConstructName, Handle, Options, State } from "mdast-util-to-markdown";

import type { WikiLink } from "./types";

/**
 * Create an mdast-util `toMarkdown` extension for wikilinks.
 */
export function toMarkdown(): Options {
  return {
    handlers: {
      wikilink: handleWikilink,
    } as Record<string, Handle>,
    unsafe: [
      { character: "[", inConstruct: "phrasing", notInConstruct: "wikilink" as ConstructName },
    ],
  };
}

/**
 * Serialize a `WikiLink` node back to `[[target]]` or `[[target|alias]]`.
 */
function handleWikilink(node: WikiLink, _parent: Parents | undefined, state: State): string {
  const exit = state.enter("wikilink" as ConstructName);
  const inner =
    node.alias != null && node.alias !== "" ? `${node.target}|${node.alias}` : node.target;
  exit();
  return `[[${inner}]]`;
}
