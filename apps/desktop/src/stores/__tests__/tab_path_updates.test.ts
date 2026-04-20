import { describe, expect, it } from "vitest";

import { getTabIdsForDeletedPath, renameTabsForMovedPathInList } from "~/stores/tab_path_updates";

describe("tab path updates", () => {
  it("renames editor and diff tabs for file and folder moves", () => {
    const renamedFileTabs = renameTabsForMovedPathInList(
      [
        { id: "editor", type: "editor", filePath: "notes/a.md", fileName: "a.md" },
        { id: "diff", type: "diff", filePath: "diff://notes/a.md", fileName: "Diff: a.md" },
      ],
      "notes/a.md",
      "notes/b.md",
      false,
    );

    expect(renamedFileTabs).toEqual([
      { id: "editor", type: "editor", filePath: "notes/b.md", fileName: "b.md" },
      { id: "diff", type: "diff", filePath: "diff://notes/b.md", fileName: "Diff: b.md" },
    ]);

    const renamedFolderTabs = renameTabsForMovedPathInList(
      [
        { id: "editor", type: "editor", filePath: "notes/archive/a.md", fileName: "a.md" },
        {
          id: "diff",
          type: "diff",
          filePath: "diff://notes/archive/b.md",
          fileName: "Diff: b.md",
        },
      ],
      "notes/archive",
      "notes/renamed",
      true,
    );

    expect(renamedFolderTabs).toEqual([
      { id: "editor", type: "editor", filePath: "notes/renamed/a.md", fileName: "a.md" },
      {
        id: "diff",
        type: "diff",
        filePath: "diff://notes/renamed/b.md",
        fileName: "Diff: b.md",
      },
    ]);
  });

  it("remaps descendants when a folder is case-only renamed", () => {
    // Case-only folder rename (APFS/NTFS) keeps the file content intact but
    // changes the on-disk casing. Child tabs must adopt the new casing, or
    // the subsequent vault reconcile will treat them as orphans and close
    // them — losing the user's open context.
    const result = renameTabsForMovedPathInList(
      [
        { id: "editor", type: "editor", filePath: "Notes/draft.md", fileName: "draft.md" },
        {
          id: "diff",
          type: "diff",
          filePath: "diff://Notes/archive/b.md",
          fileName: "Diff: b.md",
        },
      ],
      "notes",
      "NOTES",
      true,
    );

    expect(result).toEqual([
      { id: "editor", type: "editor", filePath: "NOTES/draft.md", fileName: "draft.md" },
      {
        id: "diff",
        type: "diff",
        filePath: "diff://NOTES/archive/b.md",
        fileName: "Diff: b.md",
      },
    ]);
  });

  it("collects editor and diff tabs affected by file and folder deletion", () => {
    const tabs = [
      { id: "editor", type: "editor", filePath: "notes/archive/a.md", fileName: "a.md" },
      { id: "diff", type: "diff", filePath: "diff://notes/archive/b.md", fileName: "Diff: b.md" },
      { id: "graph", type: "graph", filePath: null, fileName: "Graph" },
    ];

    expect(getTabIdsForDeletedPath(tabs, "notes/archive/a.md", false)).toEqual(["editor"]);
    expect(getTabIdsForDeletedPath(tabs, "notes/archive", true)).toEqual(["editor", "diff"]);
  });

  it("matches deleted folder targets case-insensitively", () => {
    // When the vault browser deletes `NOTES/archive/` but the tabs still
    // hold the pre-rename casing, case-sensitive matching would leave the
    // descendants open referring to a path that no longer exists.
    const tabs = [
      { id: "editor", type: "editor", filePath: "notes/archive/a.md", fileName: "a.md" },
      { id: "diff", type: "diff", filePath: "diff://notes/archive/b.md", fileName: "Diff: b.md" },
    ];

    expect(getTabIdsForDeletedPath(tabs, "NOTES/archive", true)).toEqual(["editor", "diff"]);
  });
});
