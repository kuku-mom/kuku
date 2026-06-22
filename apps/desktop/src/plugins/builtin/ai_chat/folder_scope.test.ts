import { describe, expect, it } from "vitest";

import type { FileEntry } from "~/lib/vault_fs";

import type { ChatConversationScope } from "./types";
import {
  getFolderProjectSnapshot,
  getFolderScopeOptions,
  projectFolderForScope,
  scopeMessageAttachment,
} from "./folder_scope";

const entries: FileEntry[] = [
  {
    name: "Kuku",
    path: "Kuku",
    is_directory: true,
    children: [
      { name: "PROJECT.md", path: "Kuku/PROJECT.md", is_directory: false },
      { name: "NEXT.md", path: "Kuku/NEXT.md", is_directory: false },
      {
        name: "Decisions",
        path: "Kuku/Decisions",
        is_directory: true,
        children: [
          {
            name: "2026-06-22-scope.md",
            path: "Kuku/Decisions/2026-06-22-scope.md",
            is_directory: false,
          },
        ],
      },
      {
        name: "Meetings",
        path: "Kuku/Meetings",
        is_directory: true,
        children: [
          {
            name: "2026-06-21-sync.md",
            path: "Kuku/Meetings/2026-06-21-sync.md",
            is_directory: false,
          },
        ],
      },
      {
        name: "Proposals",
        path: "Kuku/Proposals",
        is_directory: true,
        children: [
          {
            name: "handoff.proposal.md",
            path: "Kuku/Proposals/handoff.proposal.md",
            is_directory: false,
          },
        ],
      },
    ],
  },
  {
    name: "Nested",
    path: "Kuku/Nested",
    is_directory: true,
    children: [],
  },
  { name: "Loose.md", path: "Loose.md", is_directory: false },
];

describe("folder scope helpers", () => {
  it("only exposes first-level folders as chat scope options", () => {
    expect(getFolderScopeOptions(entries)).toEqual([
      {
        folder: "Kuku",
        label: "Kuku",
        missingFiles: ["AGENTS.md"],
      },
    ]);
  });

  it("summarizes standard files and recent activity for the overview card", () => {
    expect(getFolderProjectSnapshot(entries, "Kuku")).toEqual({
      folder: "Kuku",
      presentFiles: ["PROJECT.md", "NEXT.md"],
      missingFiles: ["AGENTS.md"],
      decisionCount: 1,
      meetingCount: 1,
      proposalCount: 1,
    });
  });

  it("maps folder scopes to message chips and editor context project folders", () => {
    const scope: ChatConversationScope = { kind: "folder", folder: "Kuku" };

    expect(scopeMessageAttachment(scope)).toEqual({
      kind: "scope",
      scope: "folder",
      folder: "Kuku",
      label: "Folder: Kuku",
    });
    expect(projectFolderForScope(scope)).toBe("Kuku");
    expect(projectFolderForScope({ kind: "vault" })).toBeNull();
  });
});
