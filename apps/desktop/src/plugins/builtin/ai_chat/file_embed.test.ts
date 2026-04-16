import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileEntry } from "~/lib/vault_fs";

import {
  MAX_FILE_ATTACHMENTS,
  appendFileAttachment,
  fileAttachmentFromSuggestion,
  getFileEmbedSuggestions,
  prepareEmbeddedFilesForSend,
  resolveFileMentionTrigger,
} from "./file_embed";

const mocks = vi.hoisted(() => ({
  readVaultFileWithChecksum: vi.fn(),
}));

vi.mock("~/lib/vault_fs", () => ({
  readVaultFileWithChecksum: mocks.readVaultFileWithChecksum,
}));

function file(name: string, path: string): FileEntry {
  return { name, path, is_directory: false };
}

function dir(name: string, path: string, children: FileEntry[] = []): FileEntry {
  return { name, path, is_directory: true, children };
}

describe("ai_chat file_embed mention trigger", () => {
  it("resolves @query at the start of a token", () => {
    expect(resolveFileMentionTrigger("@base", 5)).toEqual({
      from: 0,
      to: 5,
      query: "base",
    });
    expect(resolveFileMentionTrigger("see @base", 9)).toEqual({
      from: 4,
      to: 9,
      query: "base",
    });
  });

  it("ignores email-like text", () => {
    expect(resolveFileMentionTrigger("hello a@b", 9)).toBeNull();
  });
});

describe("ai_chat file_embed suggestions", () => {
  it("returns markdown file suggestions from the vault tree", () => {
    const entries: FileEntry[] = [
      file("Base.md", "Base.md"),
      file("image.png", "image.png"),
      dir("notes", "notes", [file("Daily.md", "notes/Daily.md")]),
    ];

    const result = getFileEmbedSuggestions(entries, "");

    expect(result).toEqual([
      { name: "Base", path: "Base.md", folder: "" },
      { name: "Daily", path: "notes/Daily.md", folder: "notes" },
    ]);
  });
});

describe("ai_chat file_embed attachments", () => {
  beforeEach(() => {
    mocks.readVaultFileWithChecksum.mockReset();
  });

  it("dedupes attachments by path", () => {
    const attachment = fileAttachmentFromSuggestion({
      name: "Base",
      path: "Base.md",
      folder: "",
    });

    expect(appendFileAttachment([attachment], attachment)).toEqual([attachment]);
  });

  it("limits attachment count", () => {
    const current = Array.from({ length: MAX_FILE_ATTACHMENTS }, (_, index) => ({
      name: `Note ${index}`,
      path: `Note ${index}.md`,
      folder: "",
    }));

    expect(() =>
      appendFileAttachment(current, {
        name: "Extra",
        path: "Extra.md",
        folder: "",
      }),
    ).toThrow("You can attach up to 5 files.");
  });

  it("reads content and checksum for send payload", async () => {
    mocks.readVaultFileWithChecksum.mockResolvedValue({
      content: "# Base",
      checksum: "checksum-1",
    });

    const prepared = await prepareEmbeddedFilesForSend([
      { name: "Base", path: "Base.md", folder: "" },
    ]);

    expect(mocks.readVaultFileWithChecksum).toHaveBeenCalledWith("Base.md");
    expect(prepared.embeddedFiles).toEqual([
      {
        path: "Base.md",
        content: "# Base",
        checksum: "checksum-1",
        sizeBytes: 6,
      },
    ]);
    expect(prepared.messageAttachments).toEqual([
      {
        kind: "file",
        path: "Base.md",
        name: "Base",
        sizeBytes: 6,
      },
    ]);
  });
});
