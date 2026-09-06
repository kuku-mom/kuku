import { isMap, parseDocument } from "yaml";

import { eventRefKey, PROVIDERS, type EventRef, type TaskRef, type TimeBlockLink } from "./types";

export const BINDINGS_PATH = "Calendar/Planner Links.md";
const FIELD = "kuku_planner_time_blocks";
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown): value is string {
  return typeof value === "string" && !!value;
}
export function validEventRef(value: unknown): value is EventRef {
  return (
    record(value) &&
    PROVIDERS.includes(value.provider as EventRef["provider"]) &&
    text(value.calendarId) &&
    text(value.itemId) &&
    ["version", "occurrence", "externalId", "start", "end"].every(
      (key) => value[key] === undefined || typeof value[key] === "string",
    )
  );
}
export function validTaskRef(value: unknown): value is TaskRef {
  return (
    record(value) &&
    (value.kind === "note"
      ? text(value.taskId) && text(value.path)
      : value.kind === "reminder" &&
        validEventRef(value.eventRef) &&
        value.eventRef.provider === "apple-reminders")
  );
}
function validLink(value: unknown): value is TimeBlockLink {
  const lastSync = record(value) && record(value.lastSync) ? value.lastSync : null;
  return (
    record(value) &&
    text(value.id) &&
    validTaskRef(value.task) &&
    validEventRef(value.eventRef) &&
    typeof value.title === "string" &&
    text(value.start) &&
    text(value.end) &&
    Number.isFinite(Date.parse(value.start)) &&
    Date.parse(value.end) > Date.parse(value.start) &&
    ["synced", "pending", "conflict", "missing"].includes(String(value.status)) &&
    !!lastSync &&
    ["title", "start", "end", "taskTitle"].every((key) => typeof lastSync[key] === "string")
  );
}
function documentFor(markdown: string) {
  const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  if (!match && /^(?:\uFEFF)?---\r?\n/.test(markdown))
    throw new Error("Planner Links has unclosed YAML frontmatter.");
  const document = parseDocument(match?.[1] ?? "");
  if (document.errors.length || (document.contents && !isMap(document.contents)))
    throw new Error("Planner Links has invalid YAML frontmatter.");
  return { document, match };
}
/** Invalid or duplicate registry records are errors, never silently discarded. */
export function readTimeBlockLinks(markdown: string): TimeBlockLink[] {
  const { document } = documentFor(markdown);
  const value = document.toJS()?.[FIELD];
  if (value === undefined) return [];
  if (
    !record(value) ||
    value.version !== 1 ||
    !Array.isArray(value.links) ||
    !value.links.every(validLink)
  )
    throw new Error("Planner Links contains invalid binding data.");
  const ids = new Set<string>();
  const tasks = new Set<string>(),
    events = new Set<string>();
  for (const link of value.links) {
    if (ids.has(link.id)) throw new Error("Planner Links contains a duplicate binding ID.");
    ids.add(link.id);
    const task =
      link.task.kind === "note" ? `note:${link.task.taskId}` : eventRefKey(link.task.eventRef);
    const event = eventRefKey(link.eventRef);
    if (tasks.has(task) || events.has(event))
      throw new Error("Planner Links binds the same task or event more than once.");
    tasks.add(task);
    events.add(event);
  }
  return value.links;
}
export function writeTimeBlockLinks(markdown: string, links: TimeBlockLink[]): string {
  // Refuse to overwrite corrupt user edits, even when replacing the last link.
  readTimeBlockLinks(markdown);
  const { document, match } = documentFor(markdown);
  if (!links.every(validLink) || new Set(links.map((link) => link.id)).size !== links.length)
    throw new Error("Invalid Planner binding update.");
  document.set(FIELD, { version: 1, links });
  const result = `---\n${document.toString()}---\n${markdown.slice(match?.[0].length ?? 0)}`;
  readTimeBlockLinks(result);
  return result;
}
export function sameInstant(a?: string, b?: string): boolean {
  if (a === b) return true;
  return !!a && !!b && Number.isFinite(Date.parse(a)) && Date.parse(a) === Date.parse(b);
}
