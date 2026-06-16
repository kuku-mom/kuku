import { describe, expect, it } from "vitest";

import {
  acceptImportCommand,
  defaultRecoveryRestorePath,
  deleteEditFileId,
  issuePath,
  keepDeleteCommand,
  recoverySnapshotDescription,
  recoverySnapshotPath,
  rejectImportCommand,
  renameFileCommand,
  renameFileIds,
  restoreRecoverySnapshotRequest,
  restoreEditedVersionCommand,
  retryMissingObjectCommand,
  reviewQueueCounts,
  reviewItemDescription,
  reviewItemPath,
} from "../review_queue_model";
import type { SyncReviewItem } from "../types";

describe("sync review queue model", () => {
  it("derives display paths from import candidates", () => {
    const item: SyncReviewItem = {
      kind: "import",
      id: "import:rename:file_1:a.md:b.md",
      reason: "largeRewrite",
      candidate: {
        kind: "externalRename",
        fileId: "file_1",
        fromNormalizedPath: "a.md",
        toNormalizedPath: "b.md",
      },
    };

    expect(reviewItemPath(item)).toBe("a.md -> b.md");
    expect(reviewItemDescription(item)).toBe("large rewrite");
  });

  it("detects delete-edit and rename resolution targets", () => {
    const deleteEdit: SyncReviewItem = {
      kind: "conflict",
      id: "delete-edit-conflict:file_1",
      issue: {
        kind: "deleteEditConflict",
        fileId: "file_1",
        displayPath: "notes/a.md",
      },
    };
    const pathConflict: SyncReviewItem = {
      kind: "conflict",
      id: "path-conflict:notes/a.md",
      issue: {
        kind: "pathConflict",
        normalizedPath: "notes/a.md",
        fileIds: ["file_1", "file_2"],
      },
    };

    expect(deleteEditFileId(deleteEdit)).toBe("file_1");
    expect(issuePath(deleteEdit.issue)).toBe("notes/a.md");
    expect(renameFileIds(pathConflict)).toEqual(["file_1", "file_2"]);
  });

  it("builds import and delete-edit resolution commands", () => {
    const importItem: SyncReviewItem = {
      kind: "import",
      id: "import:modify:file_1:a.md",
      reason: "largeRewrite",
      candidate: {
        kind: "externalModify",
        fileId: "file_1",
        normalizedPath: "a.md",
      },
    };
    const deleteEdit: SyncReviewItem = {
      kind: "conflict",
      id: "delete-edit-conflict:file_2",
      issue: {
        kind: "deleteEditConflict",
        fileId: "file_2",
        displayPath: "b.md",
      },
    };

    expect(acceptImportCommand(importItem)).toEqual({
      kind: "acceptImport",
      reviewItemId: "import:modify:file_1:a.md",
    });
    expect(rejectImportCommand(importItem)).toEqual({
      kind: "rejectImport",
      reviewItemId: "import:modify:file_1:a.md",
    });
    expect(keepDeleteCommand(deleteEdit)).toEqual({
      kind: "keepDelete",
      reviewItemId: "delete-edit-conflict:file_2",
      fileId: "file_2",
    });
    expect(restoreEditedVersionCommand(deleteEdit)).toEqual({
      kind: "restoreEditedVersion",
      reviewItemId: "delete-edit-conflict:file_2",
      fileId: "file_2",
    });
  });

  it("builds rename and retry commands with validation", () => {
    const pathConflict: SyncReviewItem = {
      kind: "conflict",
      id: "path-conflict:notes/a.md",
      issue: {
        kind: "pathConflict",
        normalizedPath: "notes/a.md",
        fileIds: ["file_1", "file_2"],
      },
    };
    const missingObject: SyncReviewItem = {
      kind: "missingObject",
      id: "missing-text-doc:file_3:text_doc_3",
      issue: {
        kind: "missingTextDoc",
        fileId: "file_3",
        textDocId: "text_doc_3",
      },
    };

    expect(renameFileCommand(pathConflict, "file_1", "  renamed.md  ")).toEqual({
      kind: "renameFile",
      reviewItemId: "path-conflict:notes/a.md",
      fileId: "file_1",
      newDisplayPath: "renamed.md",
    });
    expect(renameFileCommand(pathConflict, "missing", "renamed.md")).toBeNull();
    expect(renameFileCommand(pathConflict, "file_1", "   ")).toBeNull();
    expect(retryMissingObjectCommand(missingObject)).toEqual({
      kind: "retryMissingObject",
      reviewItemId: "missing-text-doc:file_3:text_doc_3",
    });
  });

  it("counts review queue items by kind", () => {
    const items: SyncReviewItem[] = [
      {
        kind: "import",
        id: "import:create:a.md",
        reason: "largeRewrite",
        candidate: {},
      },
      {
        kind: "projectionBlocked",
        id: "projection:file_1:a.md:Write",
        fileId: "file_1",
        normalizedPath: "a.md",
        operation: "write",
        preflight: {},
      },
      {
        kind: "conflict",
        id: "path-conflict:a.md",
        issue: {},
      },
      {
        kind: "missingObject",
        id: "missing-text-doc:file_2:text_2",
        issue: {},
      },
    ];

    expect(reviewQueueCounts(items)).toEqual({
      total: 4,
      imports: 1,
      projectionBlocked: 1,
      conflicts: 1,
      missingObjects: 1,
    });
  });

  it("builds recovery restore request helpers", () => {
    const snapshot = {
      id: "recovery:delete-edit:current:file_1",
      kind: "deleteEditCurrent",
      reason: "deleteEditConflict",
      fileId: "file_1",
      incarnationId: "inc_1",
      displayPath: "notes/a.md",
      normalizedPath: "notes/a.md",
      textDocId: "text_1",
      contentHash: "abcdef0123456789",
      sizeBytes: 1536,
      content: "restored",
    } as const;

    expect(recoverySnapshotPath(snapshot)).toBe("notes/a.md");
    expect(recoverySnapshotDescription(snapshot)).toBe("delete edit conflict · 1.5 KiB · abcdef012345");
    expect(defaultRecoveryRestorePath(snapshot)).toBe("notes/a recovered.md");
    expect(restoreRecoverySnapshotRequest(snapshot, "  notes/restored.md  ")).toEqual({
      snapshotId: "recovery:delete-edit:current:file_1",
      targetDisplayPath: "notes/restored.md",
    });
    expect(restoreRecoverySnapshotRequest(snapshot, "   ")).toBeNull();
  });
});
