import { describe, expect, it } from "vitest";

import {
  buildNameFromEditable,
  getParentPath,
  getPathName,
  isSameOrDescendantPath,
  joinVaultPath,
  pathEqualsIgnoreCase,
  remapMovedPath,
  remapPathSet,
  splitNameForEditing,
} from "~/lib/vault_path";

describe("vault path helpers", () => {
  it("splits file names for inline rename using the last extension segment", () => {
    expect(splitNameForEditing("notes.md", false)).toEqual({
      editableName: "notes",
      preservedExtension: ".md",
    });
    expect(splitNameForEditing("archive.tar.gz", false)).toEqual({
      editableName: "archive.tar",
      preservedExtension: ".gz",
    });
    expect(splitNameForEditing(".env", false)).toEqual({
      editableName: ".env",
      preservedExtension: null,
    });
    expect(splitNameForEditing("name.", false)).toEqual({
      editableName: "name.",
      preservedExtension: null,
    });
    expect(splitNameForEditing("folder", true)).toEqual({
      editableName: "folder",
      preservedExtension: null,
    });
  });

  it("builds joined names and paths", () => {
    expect(buildNameFromEditable("notes", ".md")).toBe("notes.md");
    expect(buildNameFromEditable("folder", null)).toBe("folder");
    expect(getPathName("notes/topic.md")).toBe("topic.md");
    expect(getParentPath("notes/topic.md")).toBe("notes");
    expect(getParentPath("topic.md")).toBe("");
    expect(joinVaultPath("notes", "topic.md")).toBe("notes/topic.md");
    expect(joinVaultPath("", "topic.md")).toBe("topic.md");
  });

  it("remaps moved file and folder paths without touching unrelated siblings", () => {
    expect(remapMovedPath("notes/a.md", "notes/a.md", "notes/b.md", false)).toBe("notes/b.md");
    expect(remapMovedPath("notes/archive", "notes/archive", "notes/renamed", true)).toBe(
      "notes/renamed",
    );
    expect(remapMovedPath("notes/archive/nested.md", "notes/archive", "notes/renamed", true)).toBe(
      "notes/renamed/nested.md",
    );
    expect(remapMovedPath("notes/archive-2.md", "notes/archive", "notes/renamed", true)).toBe(
      "notes/archive-2.md",
    );
    expect(
      remapPathSet(
        ["notes/archive", "notes/archive/nested.md"],
        "notes/archive",
        "notes/renamed",
        true,
      ),
    ).toEqual(new Set(["notes/renamed", "notes/renamed/nested.md"]));
  });

  it("matches exact and descendant paths for delete checks", () => {
    expect(isSameOrDescendantPath("notes/a.md", "notes/a.md", false)).toBe(true);
    expect(isSameOrDescendantPath("notes/archive/nested.md", "notes/archive", true)).toBe(true);
    expect(isSameOrDescendantPath("notes/archive-2", "notes/archive", true)).toBe(false);
  });

  it("compares paths case-insensitively to match APFS/NTFS semantics", () => {
    expect(pathEqualsIgnoreCase("notes/a.md", "NOTES/A.MD")).toBe(true);
    expect(pathEqualsIgnoreCase("notes/a.md", "notes/b.md")).toBe(false);
    expect(pathEqualsIgnoreCase("", "")).toBe(true);
  });

  it("remaps descendants after a case-only folder rename", () => {
    // `Notes/` → `NOTES/` on APFS is a real filename change, but the child
    // tab's stored path keeps the old casing until we remap it. Without
    // case-insensitive prefix matching, the descendant stays as
    // `Notes/draft.md` and vault reconciliation drops it on the next refresh.
    expect(remapMovedPath("Notes/draft.md", "notes", "NOTES", true)).toBe("NOTES/draft.md");
    expect(remapMovedPath("Notes/Archive/nested.md", "Notes/archive", "Notes/ARCHIVE", true)).toBe(
      "Notes/ARCHIVE/nested.md",
    );
  });

  it("recognises case-different descendants for delete cascades", () => {
    expect(isSameOrDescendantPath("NOTES/Archive/nested.md", "notes/archive", true)).toBe(true);
    // Sibling that only shares a prefix must still be rejected.
    expect(isSameOrDescendantPath("notes/archive-2", "NOTES/archive", true)).toBe(false);
  });
});
