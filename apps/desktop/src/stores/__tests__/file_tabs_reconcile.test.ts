import { describe, expect, it } from "vitest";

import { reconcileTabsWithExistingPaths } from "~/stores/file_tabs_reconcile";

describe("file tab reconciliation", () => {
  it("removes deleted editor tabs and activates the next surviving tab", () => {
    const result = reconcileTabsWithExistingPaths(
      [
        { id: "a", type: "editor", filePath: "notes/a.md" },
        { id: "graph", type: "graph", filePath: null },
        { id: "b", type: "editor", filePath: "notes/b.md" },
      ],
      "a",
      new Set(["notes/b.md"]),
    );

    expect(result.removedTabIds).toEqual(["a"]);
    expect(result.tabs.map((tab) => tab.id)).toEqual(["graph", "b"]);
    expect(result.activeTabId).toBe("graph");
  });

  it("keeps untitled editor tabs even when they do not map to a file path", () => {
    const result = reconcileTabsWithExistingPaths(
      [
        { id: "untitled", type: "editor", filePath: null },
        { id: "a", type: "editor", filePath: "notes/a.md" },
      ],
      "a",
      new Set<string>(),
    );

    expect(result.removedTabIds).toEqual(["a"]);
    expect(result.tabs.map((tab) => tab.id)).toEqual(["untitled"]);
    expect(result.activeTabId).toBe("untitled");
  });

  it("keeps tabs whose path differs only in case from the vault tree", () => {
    // On APFS/NTFS the on-disk casing may drift from the tab's recorded
    // casing (external rename, case-only rename round-trip, etc.). Since
    // both paths resolve to the same entry, the tab must survive reconcile.
    const result = reconcileTabsWithExistingPaths(
      [
        { id: "editor", type: "editor", filePath: "NOTES/Draft.md" },
        { id: "diff", type: "diff", filePath: "diff://Notes/archive/B.md" },
      ],
      "editor",
      new Set(["notes/draft.md", "notes/archive/b.md"]),
    );

    expect(result.removedTabIds).toEqual([]);
    expect(result.activeTabId).toBe("editor");
  });

  it("reconciles diff tabs against the source file path instead of the diff url", () => {
    const result = reconcileTabsWithExistingPaths(
      [
        { id: "diff", type: "diff", filePath: "diff://notes/a.md" },
        { id: "editor", type: "editor", filePath: "notes/b.md" },
      ],
      "diff",
      new Set(["notes/b.md"]),
    );

    expect(result.removedTabIds).toEqual(["diff"]);
    expect(result.tabs.map((tab) => tab.id)).toEqual(["editor"]);
    expect(result.activeTabId).toBe("editor");
  });
});
