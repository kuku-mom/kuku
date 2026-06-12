import highlighter, { type LanguageFn } from "highlight.js";

function registerMermaidHighlightLanguage(): void {
  if (!highlighter.getLanguage("mermaid")) {
    highlighter.registerLanguage("mermaid", defineMermaidHighlightLanguage);
  }
  if (!highlighter.getLanguage("mmd")) {
    highlighter.registerAliases(["mmd"], { languageName: "mermaid" });
  }
}

const defineMermaidHighlightLanguage: LanguageFn = (hljs) => ({
  name: "Mermaid",
  case_insensitive: false,
  keywords: {
    keyword:
      "accDescr accTitle activate alt and architecture-beta as autonumber block-beta break callback call class classDef classDiagram classDiagram-v2 click critical dateFormat deactivate destroy direction end erDiagram excludes flowchart gantt gitGraph graph includes journey linkStyle loop mindmap note opt over packet par participant pie quadrantChart rect requirementDiagram sankey-beta section sequenceDiagram stateDiagram stateDiagram-v2 style subgraph title timeline xychart-beta",
    built_in: "BT LR RL TB TD",
    literal: "false true",
  },
  contains: [
    {
      className: "comment",
      begin: /%%/,
      end: /$/,
    },
    hljs.QUOTE_STRING_MODE,
    hljs.APOS_STRING_MODE,
    {
      className: "string",
      begin: /\|/,
      end: /\|/,
    },
    {
      className: "string",
      begin: /[[({]/,
      end: /[\])}]/,
      relevance: 0,
    },
    {
      className: "operator",
      begin: /(?:<-+>?|[-.=ox]+>|<[-.=ox]+|[-.=ox]{2,}|:::+)/,
      relevance: 0,
    },
    {
      className: "attribute",
      begin: /\b[A-Za-z][\w-]*(?=\s*:)/,
    },
    {
      className: "title",
      begin: /\b[A-Za-z_][\w-]*(?=\s*[[({])/,
    },
    hljs.NUMBER_MODE,
  ],
});

export { registerMermaidHighlightLanguage };
