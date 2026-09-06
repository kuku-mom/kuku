import type { Html, ListItem, Nodes, Paragraph } from "mdast";
import remarkFrontmatter from "remark-frontmatter";

import { createProcessor } from "./markdown/processor";

export interface TaskMetadata {
  id: string;
  timeBlockLinkId?: string;
  dueDate?: string;
  plannedDate?: string;
  scheduledStart?: string;
  scheduledEnd?: string;
  timeZone?: string;
}

export interface PlannerTask {
  id: string;
  path: string;
  title: string;
  checked: boolean;
  metadata: TaskMetadata | null;
  sourceChecksum?: string;
  sourceStart: number;
  sourceEnd: number;
}

export interface TaskPatch {
  title?: string;
  checked?: boolean;
  metadata?: Partial<TaskMetadata>;
}

const processor = createProcessor({ remarkPlugins: [remarkFrontmatter] });
const commentPattern = /^<!--\s*kuku-task:\s*([\s\S]*?)\s*-->$/;

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Unknown fields survive edits so a newer metadata version is not silently lost. */
export function parseTaskMetadata(value: unknown): TaskMetadata | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const metadata = value as Record<string, unknown>;
  if (typeof metadata.id !== "string" || !/^[\w-]{1,128}$/.test(metadata.id)) return null;
  if (
    metadata.timeBlockLinkId !== undefined &&
    (typeof metadata.timeBlockLinkId !== "string" ||
      !/^[\w-]{1,128}$/.test(metadata.timeBlockLinkId))
  )
    return null;
  for (const key of ["dueDate", "plannedDate"] as const) {
    if (metadata[key] !== undefined && !validDate(metadata[key])) return null;
  }
  for (const key of ["scheduledStart", "scheduledEnd"] as const) {
    const date = metadata[key];
    if (
      date !== undefined &&
      (typeof date !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(date) ||
        !Number.isFinite(Date.parse(date)))
    )
      return null;
  }
  if (Boolean(metadata.scheduledStart) !== Boolean(metadata.scheduledEnd)) return null;
  if (
    typeof metadata.scheduledStart === "string" &&
    typeof metadata.scheduledEnd === "string" &&
    Date.parse(metadata.scheduledEnd) <= Date.parse(metadata.scheduledStart)
  )
    return null;
  if (metadata.timeZone !== undefined) {
    if (typeof metadata.timeZone !== "string") return null;
    try {
      new Intl.DateTimeFormat("en", { timeZone: metadata.timeZone }).resolvedOptions();
    } catch {
      return null;
    }
  }
  return { ...metadata } as unknown as TaskMetadata;
}

export function parseTaskMetadataComment(value: string): TaskMetadata | null {
  const match = commentPattern.exec(value.trim());
  if (!match) return null;
  try {
    return parseTaskMetadata(JSON.parse(match[1]));
  } catch {
    return null;
  }
}

export function taskMetadataComment(metadata: TaskMetadata): string {
  const parsed = parseTaskMetadata(metadata);
  if (!parsed) throw new Error("Invalid task metadata");
  // Prevent a future string field from closing an HTML comment.
  return `<!-- kuku-task: ${JSON.stringify(parsed)
    .replace(/</g, String.raw`\u003c`)
    .replace(/>/g, String.raw`\u003e`)} -->`;
}

export function getListTaskMetadata(item: ListItem): {
  metadata: TaskMetadata | null;
  comment: Html | null;
  paragraph: Paragraph | null;
} {
  const paragraph =
    item.children.find((child): child is Paragraph => child.type === "paragraph") ?? null;
  if (typeof item.checked !== "boolean" || !paragraph) {
    return { metadata: null, comment: null, paragraph };
  }
  // The marker belongs only to this item's first paragraph, never its nested tasks.
  const comments = paragraph.children.filter(
    (child): child is Html =>
      child.type === "html" && parseTaskMetadataComment(child.value) !== null,
  );
  if (comments.length !== 1) return { metadata: null, comment: null, paragraph };
  return { metadata: parseTaskMetadataComment(comments[0].value), comment: comments[0], paragraph };
}

/** A freshness token, not a security digest or a vault write checksum. */
export function taskSourceChecksum(markdown: string): string {
  let hash = 2166136261;
  for (let index = 0; index < markdown.length; index++) {
    hash = Math.imul(hash ^ markdown.charCodeAt(index), 16777619);
  }
  return `task-source:${markdown.length}:${(hash >>> 0).toString(16)}`;
}

function textContent(node: Nodes): string {
  if (node.type === "html" && parseTaskMetadataComment(node.value)) return "";
  if (node.type === "image") return node.alt ?? "";
  if ("value" in node && typeof node.value === "string") return node.value;
  if ("children" in node) return node.children.map((child) => textContent(child as Nodes)).join("");
  return "";
}

function taskItems(markdown: string): ListItem[] {
  const items: ListItem[] = [];
  function visit(node: Nodes): void {
    if (node.type === "listItem" && typeof node.checked === "boolean") items.push(node);
    if ("children" in node) node.children.forEach((child) => visit(child as Nodes));
  }
  visit(processor.parse(markdown));
  return items;
}

export function extractTasks(markdown: string, path: string): PlannerTask[] {
  const sourceChecksum = taskSourceChecksum(markdown);
  return taskItems(markdown).flatMap((item): PlannerTask[] => {
    const sourceStart = item.position?.start.offset;
    const sourceEnd = item.position?.end.offset;
    if (sourceStart === undefined || sourceEnd === undefined) return [];
    const { metadata, paragraph } = getListTaskMetadata(item);
    return [
      {
        id: metadata?.id ?? `transient:${path}:${sourceStart}:${sourceChecksum}`,
        path,
        title: paragraph ? textContent(paragraph).trim().replace(/\s+/g, " ") : "",
        checked: item.checked === true,
        metadata,
        sourceChecksum,
        sourceStart,
        sourceEnd,
      },
    ];
  });
}

export function updateTaskMarkdown(markdown: string, task: PlannerTask, patch: TaskPatch): string {
  const current = extractTasks(markdown, task.path);
  let matches: PlannerTask[];
  if (task.metadata) {
    matches = current.filter((candidate) => candidate.metadata?.id === task.metadata?.id);
  } else {
    if (!task.sourceChecksum || task.sourceChecksum !== taskSourceChecksum(markdown)) {
      throw new Error("The task's note changed. Refresh and try again.");
    }
    matches = current.filter(
      (candidate) =>
        candidate.sourceStart === task.sourceStart &&
        candidate.sourceEnd === task.sourceEnd &&
        candidate.title === task.title &&
        candidate.checked === task.checked,
    );
  }
  if (matches.length !== 1) throw new Error("The task was moved, removed, or has a duplicate ID.");
  const target = matches[0];
  if (patch.metadata?.id && patch.metadata.id !== target.metadata?.id) {
    throw new Error("A task ID cannot be replaced.");
  }
  const item = taskItems(markdown).find(
    (candidate) => candidate.position?.start.offset === target.sourceStart,
  );
  if (!item) throw new Error("Task source not found");
  const { metadata, comment, paragraph } = getListTaskMetadata(item);
  if (!paragraph?.position?.end.offset) throw new Error("Task paragraph not found");
  if (
    !metadata &&
    paragraph.children.some((child) => child.type === "html" && child.value.includes("kuku-task:"))
  ) {
    throw new Error("Task metadata is invalid. Fix it in the note before editing this task.");
  }
  const nextMetadata = { ...metadata, ...patch.metadata, id: metadata?.id ?? crypto.randomUUID() };
  const encoded = taskMetadataComment(nextMetadata);
  const edits: { start: number; end: number; text: string }[] = [];
  const commentStart = comment?.position?.start.offset;
  const commentEnd = comment?.position?.end.offset;
  if (patch.title !== undefined) {
    const title = patch.title.replace(/[\r\n]+/g, " ").trim();
    if (!title) throw new Error("A task title cannot be empty.");
    const start = paragraph.position.start.offset;
    if (start === undefined) throw new Error("Task title not found");
    // Rename only this item's first paragraph. Nested lists and following blocks remain intact.
    // Encode Markdown punctuation so external titles cannot inject new task metadata or syntax.
    const literal = title.replace(/([\\`*_{}[\]<>&])/g, String.raw`\$1`);
    edits.push({ start, end: paragraph.position.end.offset, text: `${literal} ${encoded}` });
  } else if (commentStart !== undefined && commentEnd !== undefined) {
    edits.push({ start: commentStart, end: commentEnd, text: encoded });
  } else {
    const end = paragraph.position.end.offset;
    edits.push({ start: end, end, text: ` ${encoded}` });
  }
  if (patch.checked !== undefined) {
    const marker = /^(?:[-+*]|\d+[.)])\s+\[([ xX])\]/.exec(markdown.slice(target.sourceStart));
    if (!marker) throw new Error("Task checkbox not found");
    const start = target.sourceStart + marker[0].lastIndexOf("[") + 1;
    edits.push({ start, end: start + 1, text: patch.checked ? "x" : " " });
  }
  return edits
    .sort((a, b) => b.start - a.start)
    .reduce(
      (content, edit) => content.slice(0, edit.start) + edit.text + content.slice(edit.end),
      markdown,
    );
}

/** Delete the selected task while retaining its child tasks and following note blocks. */
export function deleteTaskMarkdown(markdown: string, task: PlannerTask): string {
  // Reuse the complete identity/freshness/duplicate validation before finding source offsets.
  updateTaskMarkdown(markdown, task, {});
  const target = extractTasks(markdown, task.path).find((candidate) =>
    task.metadata
      ? candidate.metadata?.id === task.metadata.id
      : candidate.sourceStart === task.sourceStart,
  );
  if (!target) throw new Error("Task source not found");
  const item = taskItems(markdown).find(
    (candidate) => candidate.position?.start.offset === target.sourceStart,
  );
  if (!item) throw new Error("Task source not found");
  const start = markdown.lastIndexOf("\n", target.sourceStart - 1) + 1;
  const prefix = markdown.slice(start, target.sourceStart);
  const parentIndent = prefix.length;
  const quoteDepth = (prefix.match(/>/g) ?? []).length;
  let end = target.sourceEnd;
  if (markdown[end] === "\r") end++;
  if (markdown[end] === "\n") end++;
  const nextBlock = item.children[1];
  let retained = "";
  if (nextBlock?.position?.start.offset !== undefined) {
    const childStart = nextBlock.position.start.offset;
    const lineStart = markdown.lastIndexOf("\n", childStart - 1) + 1;
    const lift = Math.max(0, childStart - lineStart - parentIndent);
    retained = markdown
      .slice(lineStart, end)
      .split("\n")
      .map((line) => {
        // Container quote markers belong to the enclosing note. Only remove
        // the deleted list item's indentation after those quote markers.
        let contentStart = 0;
        for (let depth = 0; depth < quoteDepth; depth++) {
          const marker = line.indexOf(">", contentStart);
          if (marker === -1 || !/^[ \t]*$/.test(line.slice(contentStart, marker))) return line;
          contentStart = marker + 1;
        }
        const whitespace = /^[ \t]*/.exec(line.slice(contentStart))?.[0].length ?? 0;
        return line.slice(0, contentStart) + line.slice(contentStart + Math.min(lift, whitespace));
      })
      .join("\n");
    // A promoted paragraph must not become lazy continuation text belonging
    // to the preceding list item. Preserve its original block boundary.
    if (nextBlock.type !== "list" && start > 0) {
      const previousLineEnd = start - (markdown[start - 2] === "\r" ? 2 : 1);
      const previousLineStart = markdown.lastIndexOf("\n", previousLineEnd - 1) + 1;
      const previousLine = markdown.slice(previousLineStart, previousLineEnd);
      if (!/^[ \t>]*$/.test(previousLine))
        retained = `${prefix.replace(/[ \t]+$/, "")}${markdown.includes("\r\n") ? "\r\n" : "\n"}${retained}`;
    }
  }
  return markdown.slice(0, start) + retained + markdown.slice(end);
}
