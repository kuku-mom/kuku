// ── Editor Core — Markdown Handlers ──
//
// Markdown ↔ PM JSON conversion handlers for CommonMark elements.
//
// Handler code lives here (not in lib/markdown) because lib/markdown is
// the pure conversion engine layer. Concrete handlers belong in the plugin
// that defines the corresponding PM schema.

import type {
  BlockContent,
  Blockquote,
  Code,
  Delete,
  Emphasis,
  Heading,
  Html,
  Image,
  Link,
  List,
  ListItem,
  Nodes,
  Paragraph,
  PhrasingContent,
  Root,
  RootContent,
  Table,
  TableCell,
  TableRow,
  Strong,
} from "mdast";

import {
  type MdastToPmBlockHandler,
  type MdastToPmContext,
  type MdastToPmInlineHandler,
  type PMMarkJSON,
  type PMNodeJSON,
  type PmToMdastBlockHandler,
  type PmToMdastContext,
  type PmToMdastInlineHandler,
  type PmToMdastMarkHandler,
  convertMarkChildren,
  makeText,
} from "~/lib/markdown";
import type { MarkdownContribution } from "~/plugins/types";
import remarkDirective from "remark-directive";

// ── mdast → PM handlers ────────────────────────────────────────────────

const headingMdastHandler: MdastToPmBlockHandler = (node, ctx) => {
  const heading = node as Heading;
  const content = ctx.convertInlineChildren(heading.children);
  const result: PMNodeJSON = { type: "heading", attrs: { level: heading.depth } };
  if (content.length > 0) result.content = content;
  return [result];
};

const emphasisMdastHandler: MdastToPmInlineHandler = (node, marks, ctx) =>
  convertMarkChildren(node as Emphasis, marks, { type: "italic" }, ctx);

const strongMdastHandler: MdastToPmInlineHandler = (node, marks, ctx) =>
  convertMarkChildren(node as Strong, marks, { type: "bold" }, ctx);

const inlineCodeMdastHandler: MdastToPmInlineHandler = (node, marks) => {
  const code = node as { value: string };
  return [makeText(code.value.replace(/\n/g, " "), [...marks, { type: "code" }])];
};

// ── PM → mdast handlers ────────────────────────────────────────────────

const headingPmHandler: PmToMdastBlockHandler = (node, ctx) => ({
  type: "heading" as const,
  depth: (node.attrs?.level as 1 | 2 | 3 | 4 | 5 | 6) ?? 1,
  children: ctx.convertInlineChildren(node.content ?? []),
});

const boldMarkHandler: PmToMdastMarkHandler = (_mark, inner) => ({
  type: "strong" as const,
  children: [inner],
});

const italicMarkHandler: PmToMdastMarkHandler = (_mark, inner) => ({
  type: "emphasis" as const,
  children: [inner],
});

const codeMarkHandler: PmToMdastMarkHandler = (_mark, inner) => {
  const value = inner.type === "text" ? inner.value : "";
  return { type: "inlineCode" as const, value };
};

// ── Thematic break ──────────────────────────────────────────────────────

const thematicBreakMdastHandler: MdastToPmBlockHandler = () => [{ type: "horizontalRule" }];

const horizontalRulePmHandler: PmToMdastBlockHandler = () => ({
  type: "thematicBreak" as const,
});

// ── Blockquote ──────────────────────────────────────────────────────────

const blockquoteMdastHandler: MdastToPmBlockHandler = (node, ctx) => {
  const bq = node as Blockquote;
  return [
    {
      type: "blockquote",
      content: ctx.convertBlockChildren(bq.children as Nodes[]),
    },
  ];
};

const blockquotePmHandler: PmToMdastBlockHandler = (node, ctx) => ({
  type: "blockquote" as const,
  children: ctx.convertDocChildren(node.content ?? []) as BlockContent[],
});

// ── Code block ──────────────────────────────────────────────────────────

const codeBlockMdastHandler: MdastToPmBlockHandler = (node) => {
  const code = node as Code;
  const result: PMNodeJSON = {
    type: "codeBlock",
    attrs: { language: code.lang ?? "" },
  };
  if (code.value) {
    result.content = [{ type: "text", text: code.value }];
  }
  return [result];
};

const codeBlockPmHandler: PmToMdastBlockHandler = (node, ctx) => {
  const language = (node.attrs?.language as string) ?? "";
  const value = ctx.extractTextContent(node);
  if (language === "html") {
    return { type: "html" as const, value } satisfies Html;
  }
  const result: Code = { type: "code", value };
  if (language) result.lang = language;
  return result;
};

// ── Link ────────────────────────────────────────────────────────────────

const linkMdastHandler: MdastToPmInlineHandler = (node, marks, ctx) => {
  const link = node as Link;
  const linkMark: PMMarkJSON = { type: "link", attrs: { href: link.url } };
  if (link.title) linkMark.attrs = { ...linkMark.attrs, title: link.title };
  if (link.children.length === 0) {
    return [makeText(link.url, [...marks, linkMark])];
  }
  return convertMarkChildren(link, marks, linkMark, ctx);
};

const linkMarkPmHandler: PmToMdastMarkHandler = (mark, inner) => ({
  type: "link" as const,
  url: (mark.attrs?.href as string) ?? "",
  title: (mark.attrs?.title as string | undefined) ?? undefined,
  children: [inner],
});

// ── Image ───────────────────────────────────────────────────────────────

const imageMdastHandler: MdastToPmInlineHandler = (node) => {
  const img = node as Image;
  return [{ type: "image", attrs: { src: img.url, alt: img.alt ?? null } }];
};

const imagePmBlockHandler: PmToMdastBlockHandler = (node) => ({
  type: "paragraph" as const,
  children: [
    {
      type: "image" as const,
      url: (node.attrs?.src as string) ?? "",
      alt: (node.attrs?.alt as string | null | undefined) ?? undefined,
      title: undefined,
    } satisfies Image,
  ],
});

const imagePmInlineHandler: PmToMdastInlineHandler = (node) => ({
  type: "image" as const,
  url: (node.attrs?.src as string) ?? "",
  alt: (node.attrs?.alt as string | null | undefined) ?? undefined,
  title: undefined,
});

// ── Table ───────────────────────────────────────────────────────────────

const tableMdastHandler: MdastToPmBlockHandler = (node, ctx) => {
  const table = node as Table;
  if (table.children.length === 0) return null;

  return [
    {
      type: "table",
      content: table.children.map((row, index) => convertTableRow(row, index === 0, ctx)),
    },
  ];
};

function convertTableRow(row: TableRow, isHeader: boolean, ctx: MdastToPmContext): PMNodeJSON {
  return {
    type: "tableRow",
    content: row.children.map((cell) => convertTableCell(cell, isHeader, ctx)),
  };
}

function convertTableCell(cell: TableCell, isHeader: boolean, ctx: MdastToPmContext): PMNodeJSON {
  const content = ctx.convertInlineChildren(cell.children);
  return {
    type: isHeader ? "tableHeaderCell" : "tableCell",
    content: [content.length > 0 ? { type: "paragraph", content } : { type: "paragraph" }],
  };
}

const tablePmHandler: PmToMdastBlockHandler = (node, ctx) => {
  const rows = node.content ?? [];
  if (rows.length === 0) return null;

  return {
    type: "table" as const,
    children: rows.map((row) => convertPmTableRow(row, ctx)),
  };
};

function convertPmTableRow(row: PMNodeJSON, ctx: PmToMdastContext): TableRow {
  return {
    type: "tableRow",
    children: (row.content ?? []).map((cell) => convertPmTableCell(cell, ctx)),
  };
}

function convertPmTableCell(cell: PMNodeJSON, ctx: PmToMdastContext): TableCell {
  return {
    type: "tableCell",
    children: convertPmTableCellChildren(cell, ctx),
  };
}

function convertPmTableCellChildren(cell: PMNodeJSON, ctx: PmToMdastContext): PhrasingContent[] {
  const result: PhrasingContent[] = [];

  for (const child of cell.content ?? []) {
    if (child.type === "paragraph") {
      result.push(...ctx.convertInlineChildren(child.content ?? []));
      continue;
    }

    const text = ctx.extractTextContent(child);
    if (text.length > 0) {
      result.push({ type: "text", value: text });
    }
  }

  return result;
}

// ── Strikethrough (GFM) ─────────────────────────────────────────────────

const deleteMdastHandler: MdastToPmInlineHandler = (node, marks, ctx) =>
  convertMarkChildren(node as Delete, marks, { type: "strike" }, ctx);

const strikeMarkPmHandler: PmToMdastMarkHandler = (_mark, inner) => ({
  type: "delete" as const,
  children: [inner],
});

// ── HTML block/inline ───────────────────────────────────────────────────

const htmlBlockMdastHandler: MdastToPmBlockHandler = (node) => {
  const html = node as Html;
  return [
    {
      type: "codeBlock",
      attrs: { language: "html" },
      content: [{ type: "text", text: html.value }],
    },
  ];
};

const htmlInlineMdastHandler: MdastToPmInlineHandler = (node, marks) => {
  const html = node as Html;
  const normalized = html.value.trim().toLowerCase();
  if (/^<br\s*\/?>$/.test(normalized)) {
    return [{ type: "hardBreak" }];
  }
  return [makeText(html.value.replace(/\n/g, " "), marks)];
};

// ── List ────────────────────────────────────────────────────────────────

const listMdastHandler: MdastToPmBlockHandler = (node, ctx) => {
  const list = node as List;
  const kind = list.ordered ? "ordered" : "bullet";
  return list.children.map((item, index) =>
    convertListItem(item, kind, list.ordered ? (list.start ?? 1) + index : undefined, ctx),
  );
};

function convertListItem(
  item: ListItem,
  parentKind: string,
  order: number | undefined,
  ctx: MdastToPmContext,
): PMNodeJSON {
  const kind = typeof item.checked === "boolean" ? "task" : parentKind;
  const attrs: Record<string, unknown> = { kind };
  if (order !== undefined) attrs.order = order;
  if (typeof item.checked === "boolean") attrs.checked = item.checked;

  const content: PMNodeJSON[] = [];
  for (const child of item.children) {
    if (child.type === "list") {
      const listResult = listMdastHandler(child as Nodes, ctx);
      if (listResult) content.push(...listResult);
    } else {
      const result = ctx.convertBlockChildren([child as Nodes]);
      if (
        result.length === 1 &&
        result[0].type === "paragraph" &&
        !result[0].content &&
        child.type !== "paragraph"
      ) {
        // skip empty fallback paragraph
      } else {
        content.push(...result);
      }
    }
  }

  return {
    type: "list",
    attrs,
    content: content.length > 0 ? content : [{ type: "paragraph" }],
  };
}

const listPmHandler: PmToMdastBlockHandler = (node, ctx) => convertFlatListItem(node, ctx);

function convertFlatListItem(node: PMNodeJSON, ctx: PmToMdastContext): List {
  const kind = node.attrs?.kind as string | undefined;
  const ordered = kind === "ordered";
  const checked = kind === "task" ? ((node.attrs?.checked as boolean) ?? false) : undefined;

  const itemChildren: BlockContent[] = [];
  const nestedLists: List[] = [];

  for (const child of node.content ?? []) {
    if (child.type === "list") {
      const nested = convertFlatListItem(child, ctx);
      nestedLists.push(nested);
    } else {
      const converted = ctx.convertBlockNode(child);
      if (converted) itemChildren.push(converted as BlockContent);
    }
  }

  const listItem: ListItem = {
    type: "listItem",
    spread: false,
    children: itemChildren.length > 0 ? itemChildren : [{ type: "paragraph", children: [] }],
  };
  if (typeof checked === "boolean") listItem.checked = checked;

  for (const nested of nestedLists) {
    const prev = listItem.children[listItem.children.length - 1];
    if (prev && prev.type === "list" && prev.ordered === nested.ordered) {
      prev.children.push(...nested.children);
    } else {
      (listItem.children as (BlockContent | List)[]).push(nested);
    }
  }

  const list: List = {
    type: "list",
    ordered,
    spread: false,
    children: [listItem],
  };
  if (ordered && node.attrs?.order !== undefined) {
    list.start = node.attrs.order as number;
  }
  return list;
}

// ── Blank-line preservation (::br leaf directive) ────────────────────────
//
// The editor represents extra vertical spacing as consecutive empty
// paragraphs.  Standard markdown collapses those into a single blank
// line on round-trip.  To preserve them we convert empty paragraphs to
// `::br` leaf directives (remark-directive) at save time, and convert
// them back at load time.  This keeps the editor schema unchanged —
// no custom PM node or keymap needed.

function isEmptyParagraph(node: RootContent): boolean {
  return node.type === "paragraph" && node.children.length === 0;
}

/** Load path: `::br` leaf directives → empty paragraphs. */
function directivesToEmptyParagraphs(tree: Root): Root {
  const children: RootContent[] = tree.children.map((node) => {
    const directive = node as unknown as { type: string; name?: string };
    if (directive.type === "leafDirective" && directive.name === "br") {
      return { type: "paragraph", children: [] } as Paragraph;
    }
    return node;
  });
  return { ...tree, children };
}

/** Save path: empty mdast paragraphs → `::br` leaf directives. */
function emptyParagraphsToDirectives(tree: Root): Root {
  const children: RootContent[] = tree.children.map((node) => {
    if (isEmptyParagraph(node)) {
      return {
        type: "leafDirective",
        name: "br",
        attributes: {},
        children: [],
      } as unknown as RootContent;
    }
    return node;
  });
  return { ...tree, children };
}

// ── Contribution assembly ───────────────────────────────────────────────

export const editorCoreMarkdown: MarkdownContribution = {
  remarkPlugins: [remarkDirective],
  mdastTransform: {
    afterParse: directivesToEmptyParagraphs,
    beforeStringify: emptyParagraphsToDirectives,
  },
  mdastToPm: {
    block: {
      heading: headingMdastHandler,
      thematicBreak: thematicBreakMdastHandler,
      blockquote: blockquoteMdastHandler,
      code: codeBlockMdastHandler,
      html: htmlBlockMdastHandler,
      list: listMdastHandler,
      table: tableMdastHandler,
    },
    inline: {
      emphasis: emphasisMdastHandler,
      strong: strongMdastHandler,
      inlineCode: inlineCodeMdastHandler,
      link: linkMdastHandler,
      image: imageMdastHandler,
      delete: deleteMdastHandler,
      html: htmlInlineMdastHandler,
    },
  },
  pmToMdast: {
    block: {
      heading: headingPmHandler,
      horizontalRule: horizontalRulePmHandler,
      blockquote: blockquotePmHandler,
      codeBlock: codeBlockPmHandler,
      image: imagePmBlockHandler,
      list: listPmHandler,
      table: tablePmHandler,
    },
    inline: {
      image: imagePmInlineHandler,
    },
    mark: {
      bold: boldMarkHandler,
      italic: italicMarkHandler,
      code: codeMarkHandler,
      link: linkMarkPmHandler,
      strike: strikeMarkPmHandler,
    },
  },
};
