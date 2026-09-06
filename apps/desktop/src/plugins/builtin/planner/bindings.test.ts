import { describe, expect, it } from "vitest";
import { readTimeBlockLinks, writeTimeBlockLinks } from "./bindings";
import type { TimeBlockLink } from "./types";

const link: TimeBlockLink = {
  id: "link-one",
  task: { kind: "note", taskId: "task-one", path: "Notes.md" },
  eventRef: { provider: "google", calendarId: "work", itemId: "event-one", version: "v1" },
  title: "Prepare",
  start: "2026-09-04T01:00:00Z",
  end: "2026-09-04T01:30:00Z",
  status: "synced",
  lastSync: {
    title: "Prepare",
    start: "2026-09-04T01:00:00Z",
    end: "2026-09-04T01:30:00Z",
    taskTitle: "Prepare",
  },
};
describe("Planner binding registry", () => {
  it("round-trips stable identities while preserving other YAML properties and body", () => {
    const before =
      "---\nowner: Ada\n# Keep this note\ntags: [planning]\n---\n# Planner Links\n\nPersonal notes.\n";
    const after = writeTimeBlockLinks(before, [link]);
    expect(readTimeBlockLinks(after)).toEqual([link]);
    expect(after).toContain("owner: Ada");
    expect(after).toContain("# Keep this note");
    expect(after.endsWith("# Planner Links\n\nPersonal notes.\n")).toBe(true);
  });
  it("refuses corrupt YAML, duplicate IDs, and multiple blocks for one task", () => {
    expect(() => writeTimeBlockLinks("---\nbroken: [\n---\nBody", [])).toThrow();
    expect(() => writeTimeBlockLinks("# Links\n", [link, link])).toThrow();
    expect(() =>
      writeTimeBlockLinks("# Links\n", [
        link,
        { ...link, id: "other", eventRef: { ...link.eventRef, itemId: "other" } },
      ]),
    ).toThrow("same task");
    expect(() =>
      writeTimeBlockLinks("# Links\n", [
        link,
        { ...link, id: "other", task: { kind: "note", taskId: "other", path: "Other.md" } },
      ]),
    ).toThrow("same task or event");
    expect(() =>
      readTimeBlockLinks("---\nkuku_planner_time_blocks:\n  version: 2\n  links: []\n---\n"),
    ).toThrow();
  });
});
