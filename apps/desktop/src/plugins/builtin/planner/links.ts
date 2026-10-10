import { isMap, parseDocument } from "yaml";

import { externalKey, type ExternalItem } from "./types";

export interface NoteLink {
  key: string;
  provider: string;
  calendarId: string;
  itemId: string;
  externalId?: string;
  occurrence?: string;
  title: string;
}
export function hasOnlyPlannerLinks(value: string): boolean {
  try {
    const document = parseDocument(value);
    if (document.errors.length || !isMap(document.contents)) return false;
    const data = document.toJS();
    return (
      Object.keys(data).length === 1 &&
      Array.isArray(data.kuku_planner_links) &&
      data.kuku_planner_links.length > 0
    );
  } catch {
    return false;
  }
}
function frontmatter(markdown: string) {
  const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  return { match, document: parseDocument(match?.[1] ?? "") };
}
export function readNoteLinks(markdown: string): NoteLink[] {
  const { document } = frontmatter(markdown);
  if (document.errors.length) return [];
  const value = document.toJS()?.kuku_planner_links;
  return Array.isArray(value)
    ? value.filter((x): x is NoteLink => x && typeof x.key === "string")
    : [];
}
export function linkNote(markdown: string, item: ExternalItem): string {
  const { document, match } = frontmatter(markdown);
  if (!match && /^(?:\uFEFF)?---\r?\n/.test(markdown))
    throw new Error("This note has unclosed YAML frontmatter.");
  if (document.errors.length || (document.contents && !isMap(document.contents))) {
    throw new Error("This note has invalid YAML frontmatter. Fix it before linking.");
  }
  const links = readNoteLinks(markdown);
  if (links.some((link) => link.key === externalKey(item))) return markdown;
  const existing = document.toJS()?.kuku_planner_links;
  if (existing !== undefined && !Array.isArray(existing))
    throw new Error("The note's kuku_planner_links field must be a list.");
  const link: NoteLink = {
    key: externalKey(item),
    provider: item.provider,
    calendarId: item.calendarId,
    itemId: item.id,
    title: item.title,
  };
  if (item.externalId) link.externalId = item.externalId;
  if (item.occurrence) link.occurrence = item.occurrence;
  document.set("kuku_planner_links", [...(existing ?? []), link]);
  return `---\n${document.toString()}---\n${markdown.slice(match?.[0].length ?? 0)}`;
}
