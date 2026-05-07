import type { Literal } from "mdast";

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
