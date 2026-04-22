import type {
  Heading,
  Image,
  Link,
  List,
  ListItem,
  PhrasingContent,
  Root,
  RootContent,
  Table,
  TableCell,
  TableRow,
} from "mdast";

import { createMemo, type JSX } from "solid-js";

import ScrollArea from "~/components/scroll_area";
import { createProcessor } from "~/lib/markdown";
import { getMarkdownService } from "~/plugins/markdown_service";

const fallbackProcessor = createProcessor();

type RenderableContent = RootContent | PhrasingContent;
type WikiLinkNode = RenderableContent & {
  type: "wikilink";
  alias?: string;
  target: string;
  value?: string;
};

// ── Render helpers ──────────────────────────────────────────────────────

function renderChildren(children: readonly RenderableContent[]): JSX.Element {
  return <>{children.map(renderNode)}</>;
}

function renderHeading(node: Heading): JSX.Element {
  const depth = Math.min(Math.max(node.depth, 1), 6);
  const children = renderChildren(node.children);
  switch (depth) {
    case 1:
      return <h1>{children}</h1>;
    case 2:
      return <h2>{children}</h2>;
    case 3:
      return <h3>{children}</h3>;
    case 4:
      return <h4>{children}</h4>;
    case 5:
      return <h5>{children}</h5>;
    default:
      return <h6>{children}</h6>;
  }
}

function TaskCheckbox(props: { checked: boolean; disabled?: boolean }): JSX.Element {
  return (
    <span
      class="kuku-task-checkbox"
      data-disabled={props.disabled ? "" : undefined}
      aria-hidden={props.disabled ? "true" : undefined}
    >
      <input
        type="checkbox"
        checked={props.checked}
        disabled={props.disabled}
        tabindex={props.disabled ? -1 : undefined}
        class="kuku-task-checkbox__input"
      />
      <span class="kuku-task-checkbox__control" />
    </span>
  );
}

function renderList(node: List): JSX.Element {
  const isTaskList = node.children.some((child) => typeof child.checked === "boolean");
  const items = node.children.map(renderListItem);
  if (node.ordered) {
    return (
      <ol
        class={isTaskList ? "kuku-markdown-task-list space-y-1.5" : undefined}
        style={
          isTaskList ? { "list-style": "none", "padding-left": "0", "margin-left": "0" } : undefined
        }
        start={node.start && node.start > 1 ? node.start : undefined}
      >
        {items}
      </ol>
    );
  }
  return (
    <ul
      class={isTaskList ? "kuku-markdown-task-list space-y-1.5" : undefined}
      style={
        isTaskList ? { "list-style": "none", "padding-left": "0", "margin-left": "0" } : undefined
      }
    >
      {items}
    </ul>
  );
}

function renderListItem(node: ListItem): JSX.Element {
  const content =
    node.children.length > 0 ? (
      renderChildren(node.children as readonly RenderableContent[])
    ) : (
      <p />
    );

  if (typeof node.checked === "boolean") {
    return (
      <li class="kuku-markdown-task-item" style={{ "margin-left": "0", "list-style": "none" }}>
        <div class="flex items-start gap-2.5">
          <TaskCheckbox checked={node.checked} disabled />
          <div class="kuku-markdown-task-item-content min-w-0 flex-1">{content}</div>
        </div>
      </li>
    );
  }

  return <li>{content}</li>;
}

function renderLink(node: Link): JSX.Element {
  return (
    <a href={node.url} target="_blank" rel="noreferrer noopener">
      {renderChildren(node.children)}
    </a>
  );
}

function renderImage(node: Image): JSX.Element {
  return (
    <a href={node.url} target="_blank" rel="noreferrer noopener">
      {node.alt || node.url}
    </a>
  );
}

function renderWikiLink(node: WikiLinkNode): JSX.Element {
  const label = node.alias || node.value || node.target;
  return (
    <span class="text-accent underline underline-offset-2" title={node.target}>
      {label}
    </span>
  );
}

function renderTableRow(node: TableRow, isHead: boolean): JSX.Element {
  return <tr>{node.children.map((cell) => renderTableCell(cell, isHead))}</tr>;
}

function renderTableCell(node: TableCell, isHead: boolean): JSX.Element {
  const children = renderChildren(node.children);
  return isHead ? <th>{children}</th> : <td>{children}</td>;
}

function renderFallback(node: RenderableContent): JSX.Element {
  if ("children" in node && Array.isArray(node.children)) {
    return renderChildren(node.children as readonly RenderableContent[]);
  }
  if ("target" in node && typeof node.target === "string") {
    return node.target as unknown as JSX.Element;
  }
  if ("value" in node && typeof node.value === "string") {
    return node.value as unknown as JSX.Element;
  }
  return null as unknown as JSX.Element;
}

// ── ScrollArea-wrapped blocks ───────────────────────────────────────────

function MarkdownCodeBlock(props: { value: string; language?: string }): JSX.Element {
  return (
    <div class="kuku-md-code-fence w-full max-w-full min-w-0 overflow-hidden rounded-xs">
      <pre>
        <code data-language={props.language}>{props.value}</code>
      </pre>
    </div>
  );
}

function MarkdownTable(props: { node: Table }): JSX.Element {
  const [head, ...body] = props.node.children;
  return (
    <div class="w-full max-w-full min-w-0">
      <ScrollArea axis="x" scrollbarAutoHide="leave" class="w-full max-w-full min-w-0">
        <table class="min-w-max">
          {head && <thead>{renderTableRow(head, true)}</thead>}
          {body.length > 0 && <tbody>{body.map((row) => renderTableRow(row, false))}</tbody>}
        </table>
      </ScrollArea>
    </div>
  );
}

// ── Main node dispatch ──────────────────────────────────────────────────

function renderNode(node: RenderableContent): JSX.Element {
  switch (node.type) {
    case "paragraph":
      return <p>{renderChildren(node.children)}</p>;
    case "text":
      return node.value as unknown as JSX.Element;
    case "strong":
      return <strong>{renderChildren(node.children)}</strong>;
    case "emphasis":
      return <em>{renderChildren(node.children)}</em>;
    case "delete":
      return <del>{renderChildren(node.children)}</del>;
    case "inlineCode":
      return <code>{node.value}</code>;
    case "code":
      return <MarkdownCodeBlock value={node.value} language={node.lang || undefined} />;
    case "blockquote":
      return (
        <blockquote>{renderChildren(node.children as readonly RenderableContent[])}</blockquote>
      );
    case "heading":
      return renderHeading(node);
    case "list":
      return renderList(node);
    case "listItem":
      return renderListItem(node);
    case "thematicBreak":
      return <hr />;
    case "break":
      return <br />;
    case "link":
      return renderLink(node);
    case "image":
      return renderImage(node);
    case "wikilink":
      return renderWikiLink(node as WikiLinkNode);
    case "table":
      return <MarkdownTable node={node} />;
    case "tableRow":
      return renderTableRow(node, false);
    case "tableCell":
      return renderTableCell(node, false);
    case "html":
      return <code>{node.value}</code>;
    default:
      return renderFallback(node);
  }
}

// ── Markdown → JSX ──────────────────────────────────────────────────────

function parseMarkdownTree(source: string): Root {
  const markdown = getMarkdownService();
  if (markdown) {
    return markdown.parseMdast(source);
  }
  return fallbackProcessor.parse(source);
}

function renderMarkdown(source: string): JSX.Element {
  try {
    const tree = parseMarkdownTree(source) as { children: RootContent[] };
    return renderChildren(tree.children);
  } catch {
    return <p>{source}</p>;
  }
}

// ── Wrapper typography styles ───────────────────────────────────────────
//
// Code-block and table overflow are handled by ScrollArea components above.
// Only typography / colour rules remain here.

const MARKDOWN_STYLES = [
  // Layout (kuku-md-message: token-based inline `code` colour in index.css)
  "kuku-md-message space-y-3 text-inherit",
  // Links
  "[&_a]:text-accent [&_a]:underline [&_a]:underline-offset-2",
  // Blockquote
  "[&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-text-muted",
  // Inline code; bg/text from index.css; `break-words` for long tokens
  "[&_code]:rounded-xs [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:wrap-break-word",
  // Fenced: strip chip padding/background
  "[&_pre_code]:bg-transparent [&_pre_code]:p-0",
  // Strikethrough
  "[&_del]:opacity-80",
  // Headings
  "[&_h1]:text-lg [&_h1]:font-semibold [&_h2]:text-base [&_h2]:font-semibold [&_h3]:font-semibold",
  // Horizontal rule
  "[&_hr]:border-border/70",
  // Lists — padding on the parent reserves space for `list-style-position:
  // outside` markers. `ml` on the child doesn't, so wide markers (e.g. "10.",
  // "100.") overflow left past the list. Task list items opt out via their
  // own `margin-left: 0` inline style.
  "[&_ol]:list-decimal [&_ol]:pl-8 [&_ul]:list-disc [&_ul]:pl-6",
  // Paragraphs
  "[&_p]:whitespace-pre-wrap",
  // Tables — same line colour as `hr` (---) above
  "[&_table]:w-full [&_table]:border-collapse",
  "[&_tbody_tr:not(:last-child)]:border-b [&_tbody_tr:not(:last-child)]:border-border/70",
  "[&_td]:border [&_td]:border-border/70 [&_td]:px-2 [&_td]:py-1.5",
  "[&_th]:border [&_th]:border-border/70 [&_th]:bg-bg-primary/50 [&_th]:px-2 [&_th]:py-1.5",
].join(" ");

// ── Component ───────────────────────────────────────────────────────────

function MarkdownMessage(props: { content: string }): JSX.Element {
  const rendered = createMemo(() => renderMarkdown(props.content));
  return <div class={`w-full max-w-full min-w-0 ${MARKDOWN_STYLES}`}>{rendered()}</div>;
}

export { MarkdownMessage };
