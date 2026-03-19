import type { Nodes } from "mdast";
import type { Extension, Handle } from "mdast-util-from-markdown";

import type { WikiLink } from "./types";

function top(stack: unknown[]): WikiLink {
  return stack[stack.length - 1] as WikiLink;
}

export function fromMarkdown(): Extension {
  return {
    enter: {
      wikilink: enterWikilink,
    },
    exit: {
      wikilinkData: exitWikilinkData,
      wikilinkAliasData: exitWikilinkAliasData,
      wikilink: exitWikilink,
    },
  };
}

const enterWikilink: Handle = function (token) {
  const node: WikiLink = {
    type: "wikilink",
    target: "",
    value: "",
  };
  this.enter(node as unknown as Nodes, token);
};

const exitWikilinkData: Handle = function (token) {
  top(this.stack).target = this.sliceSerialize(token);
};

const exitWikilinkAliasData: Handle = function (token) {
  top(this.stack).alias = this.sliceSerialize(token);
};

const exitWikilink: Handle = function (token) {
  const node = top(this.stack);
  node.value = node.alias ?? node.target;
  this.exit(token);
};
