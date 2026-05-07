interface DecisionDocumentSummary {
  path: string;
  title: string;
  status: string;
  updatedAt?: string;
  decisionCount: number;
  missingRequiredCount: number;
}

interface MemorySummary {
  path: string;
  id: string;
  title: string;
  status: string;
  updatedAt?: string;
  kind?: string;
  tags: string[];
}

interface ApplyJournalSummary {
  path: string;
  docId?: string;
  decisionDocumentPath?: string;
  state?: string;
  updatedAt?: string;
  error?: string;
  createdPaths: string[];
}

function parseDecisionDocumentSummary(
  path: string,
  markdown: string,
): DecisionDocumentSummary | null {
  const frontmatter = parseFrontmatter(markdown);
  if (!frontmatter) return null;

  const decisionBlocks = parseDecisionBlocks(markdown);
  return {
    path,
    title: frontmatter.scalars.title ?? baseName(path),
    status: frontmatter.scalars.status ?? "unknown",
    updatedAt: frontmatter.scalars.updated_at,
    decisionCount: decisionBlocks.length,
    missingRequiredCount: decisionBlocks.filter(
      (block) => block.required !== false && !block.selectedOptionId,
    ).length,
  };
}

function parseMemorySummary(path: string, markdown: string): MemorySummary | null {
  const frontmatter = parseFrontmatter(markdown);
  if (!frontmatter) return null;
  const id = frontmatter.scalars.id;
  const title = frontmatter.scalars.title;
  if (!id || !title) return null;

  return {
    path,
    id,
    title,
    status: frontmatter.scalars.status ?? "unknown",
    updatedAt: frontmatter.scalars.updated_at,
    kind: frontmatter.scalars.kind,
    tags: frontmatter.arrays.tags ?? [],
  };
}

function parseApplyJournalSummary(path: string, content: string): ApplyJournalSummary | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }

  return {
    path,
    docId: stringValue(parsed.doc_id),
    decisionDocumentPath: stringValue(parsed.decision_document_path),
    state: stringValue(parsed.state),
    updatedAt: stringValue(parsed.updated_at),
    error: stringValue(parsed.error),
    createdPaths: Array.isArray(parsed.created_paths)
      ? parsed.created_paths.filter((value): value is string => typeof value === "string")
      : [],
  };
}

function isInboxDecisionStatus(status: string): boolean {
  return ["pending", "partially_applied", "needs_revision", "apply_failed"].includes(status);
}

function hasRecoveryWarning(journal: ApplyJournalSummary): boolean {
  return journal.state !== undefined;
}

function sortDecisionDocuments(items: DecisionDocumentSummary[]): DecisionDocumentSummary[] {
  return [...items].sort(
    (left, right) =>
      compareDescOptional(left.updatedAt, right.updatedAt) || left.path.localeCompare(right.path),
  );
}

function sortRecentMemory(items: MemorySummary[]): MemorySummary[] {
  return [...items].sort(
    (left, right) =>
      compareDescOptional(left.updatedAt, right.updatedAt) || left.path.localeCompare(right.path),
  );
}

function sortApplyJournals(items: ApplyJournalSummary[]): ApplyJournalSummary[] {
  return [...items].sort(
    (left, right) =>
      compareDescOptional(left.updatedAt, right.updatedAt) || left.path.localeCompare(right.path),
  );
}

function deriveContextQuery(path: string | null | undefined): string {
  if (!path) return "";
  return baseName(path)
    .replace(/\.[^.]+$/, "")
    .replace(/[-_]+/g, " ")
    .trim();
}

function parseFrontmatter(markdown: string): {
  scalars: Record<string, string>;
  arrays: Record<string, string[]>;
} | null {
  if (!markdown.startsWith("---\n")) return null;
  const closingIndex = markdown.indexOf("\n---\n", 4);
  if (closingIndex === -1) return null;

  const frontmatter = markdown.slice(4, closingIndex);
  const lines = frontmatter.split("\n");
  const scalars: Record<string, string> = {};
  const arrays: Record<string, string[]> = {};

  for (let index = 0; index < lines.length; index += 1) {
    const match = /^([A-Za-z0-9_]+):(?:\s*(.*))?$/.exec(lines[index]);
    if (!match) continue;

    const key = match[1];
    const rest = match[2] ?? "";
    if (rest === "[]") {
      arrays[key] = [];
      continue;
    }
    if (rest !== "") {
      scalars[key] = unquoteScalar(rest);
      continue;
    }

    const values: string[] = [];
    let cursor = index + 1;
    while (cursor < lines.length) {
      const item = /^-\s+(.*)$/.exec(lines[cursor]);
      if (!item) break;
      values.push(unquoteScalar(item[1]));
      cursor += 1;
    }
    if (values.length > 0) {
      arrays[key] = values;
      index = cursor - 1;
    }
  }

  return { scalars, arrays };
}

function parseDecisionBlocks(markdown: string): {
  required?: boolean;
  selectedOptionId?: string;
}[] {
  const blocks: { required?: boolean; selectedOptionId?: string }[] = [];
  const regex = /```kuku-decision\n([\s\S]*?)\n```/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(markdown))) {
    const body = match[1];
    blocks.push({
      required: parseBooleanScalar(body, "required"),
      selectedOptionId: parseScalar(body, "selected_option_id"),
    });
  }
  return blocks;
}

function parseScalar(body: string, key: string): string | undefined {
  const match = new RegExp(`^${key}:\\s*(.+)$`, "m").exec(body);
  return match ? unquoteScalar(match[1]) : undefined;
}

function parseBooleanScalar(body: string, key: string): boolean | undefined {
  const value = parseScalar(body, key);
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function unquoteScalar(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function baseName(path: string): string {
  return path.split("/").at(-1) ?? path;
}

function compareDescOptional(left: string | undefined, right: string | undefined): number {
  if (left === right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  return right.localeCompare(left);
}

export {
  deriveContextQuery,
  hasRecoveryWarning,
  isInboxDecisionStatus,
  parseApplyJournalSummary,
  parseDecisionDocumentSummary,
  parseMemorySummary,
  sortApplyJournals,
  sortDecisionDocuments,
  sortRecentMemory,
};
export type { ApplyJournalSummary, DecisionDocumentSummary, MemorySummary };
