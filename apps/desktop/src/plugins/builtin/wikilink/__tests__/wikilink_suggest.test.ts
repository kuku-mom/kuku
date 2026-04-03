import { describe, it, expect } from "vitest";
import type { FileEntry } from "~/lib/vault_fs";

import {
  flattenMarkdownFiles,
  filterWikilinkSuggestions,
  type WikilinkSuggestItem,
} from "../wikilink_suggest";

// ── Helpers ─────────────────────────────────────────────────────────

function file(name: string, path: string): FileEntry {
  return { name, path, is_directory: false };
}

function dir(name: string, path: string, children: FileEntry[] = []): FileEntry {
  return { name, path, is_directory: true, children };
}

// ── flattenMarkdownFiles ────────────────────────────────────────────

describe("flattenMarkdownFiles", () => {
  it("returns an empty array for an empty tree", () => {
    expect(flattenMarkdownFiles([])).toEqual([]);
  });

  it("extracts markdown files from a flat list", () => {
    const entries: FileEntry[] = [
      file("hello.md", "hello.md"),
      file("readme.txt", "readme.txt"),
      file("notes.md", "notes.md"),
    ];

    const result = flattenMarkdownFiles(entries);

    expect(result).toEqual([
      { name: "hello", path: "hello.md", folder: "" },
      { name: "notes", path: "notes.md", folder: "" },
    ]);
  });

  it("ignores non-markdown files", () => {
    const entries: FileEntry[] = [
      file("image.png", "image.png"),
      file("data.json", "data.json"),
      file(".hidden", ".hidden"),
    ];

    expect(flattenMarkdownFiles(entries)).toEqual([]);
  });

  it("recursively traverses directories", () => {
    const entries: FileEntry[] = [
      dir("docs", "docs", [
        file("guide.md", "docs/guide.md"),
        dir("api", "docs/api", [file("reference.md", "docs/api/reference.md")]),
      ]),
      file("index.md", "index.md"),
    ];

    const result = flattenMarkdownFiles(entries);

    expect(result).toEqual([
      { name: "guide", path: "docs/guide.md", folder: "docs" },
      { name: "reference", path: "docs/api/reference.md", folder: "docs/api" },
      { name: "index", path: "index.md", folder: "" },
    ]);
  });

  it("handles directories with no children gracefully", () => {
    const entries: FileEntry[] = [dir("empty", "empty"), file("note.md", "note.md")];

    expect(flattenMarkdownFiles(entries)).toEqual([{ name: "note", path: "note.md", folder: "" }]);
  });
});

// ── filterWikilinkSuggestions ───────────────────────────────────────

describe("filterWikilinkSuggestions", () => {
  const items: WikilinkSuggestItem[] = [
    { name: "Daily Log", path: "journal/Daily Log.md", folder: "journal" },
    { name: "Meeting Notes", path: "work/Meeting Notes.md", folder: "work" },
    { name: "daily standup", path: "work/daily standup.md", folder: "work" },
    { name: "README", path: "README.md", folder: "" },
    { name: "Architecture", path: "docs/Architecture.md", folder: "docs" },
  ];

  it("returns all items (except current file) when query is empty", () => {
    const result = filterWikilinkSuggestions(items, "");
    expect(result).toHaveLength(5);
  });

  it("excludes the current file path", () => {
    const result = filterWikilinkSuggestions(items, "", "README.md");
    expect(result).toHaveLength(4);
    expect(result.find((r) => r.path === "README.md")).toBeUndefined();
  });

  it("filters by name substring (case-insensitive)", () => {
    const result = filterWikilinkSuggestions(items, "meet");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Meeting Notes");
  });

  it("filters by path substring when name does not match", () => {
    const result = filterWikilinkSuggestions(items, "journal");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Daily Log");
  });

  it("ranks name-prefix matches above name-substring matches", () => {
    const result = filterWikilinkSuggestions(items, "daily");

    // "Daily Log" starts with "daily" → best tier
    // "daily standup" starts with "daily" → best tier (shorter name wins)
    expect(result.length).toBe(2);
    expect(result[0].name).toBe("Daily Log");
    expect(result[1].name).toBe("daily standup");
  });

  it("returns empty array when nothing matches", () => {
    const result = filterWikilinkSuggestions(items, "zzzzz");
    expect(result).toEqual([]);
  });

  it("combines current file exclusion with query filtering", () => {
    const result = filterWikilinkSuggestions(items, "daily", "journal/Daily Log.md");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("daily standup");
  });

  it("matches against the full path including folder", () => {
    const result = filterWikilinkSuggestions(items, "docs/arch");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Architecture");
  });

  it("prefers shorter names among same-tier matches", () => {
    const testItems: WikilinkSuggestItem[] = [
      { name: "abc-longer-name", path: "abc-longer-name.md", folder: "" },
      { name: "abc", path: "abc.md", folder: "" },
      { name: "abc-medium", path: "abc-medium.md", folder: "" },
    ];

    const result = filterWikilinkSuggestions(testItems, "abc");

    // All are prefix matches; shorter names should rank higher.
    expect(result[0].name).toBe("abc");
    expect(result[1].name).toBe("abc-medium");
    expect(result[2].name).toBe("abc-longer-name");
  });
});
