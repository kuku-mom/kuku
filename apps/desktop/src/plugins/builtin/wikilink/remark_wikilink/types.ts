import type { Literal } from "mdast";
import type { Extension as FromMarkdownExtension } from "mdast-util-from-markdown";
import type { Options as ToMarkdownExtension } from "mdast-util-to-markdown";
import type { Extension as MicromarkExtension } from "micromark-util-types";

export interface WikiLink extends Literal {
  type: "wikilink";
  target: string;
  alias?: string | undefined;
}

declare module "mdast" {
  interface PhrasingContentMap {
    wikilink: WikiLink;
  }
}

declare module "micromark-util-types" {
  interface TokenTypeMap {
    wikilink: "wikilink";
    wikilinkMarkerOpen: "wikilinkMarkerOpen";
    wikilinkTarget: "wikilinkTarget";
    wikilinkData: "wikilinkData";
    wikilinkSeparator: "wikilinkSeparator";
    wikilinkAlias: "wikilinkAlias";
    wikilinkAliasData: "wikilinkAliasData";
    wikilinkMarkerClose: "wikilinkMarkerClose";
  }
}

export interface RemarkWikilinkData {
  micromarkExtensions?: MicromarkExtension[];
  fromMarkdownExtensions?: FromMarkdownExtension[];
  toMarkdownExtensions?: ToMarkdownExtension[];
}
