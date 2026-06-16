import type {
  SyncRecoveryRestoreRequest,
  SyncRecoverySnapshot,
  SyncReviewItem,
  SyncReviewResolutionCommand,
} from "./types";

interface SyncReviewQueueCounts {
  total: number;
  imports: number;
  projectionBlocked: number;
  conflicts: number;
  missingObjects: number;
}

function reviewQueueCounts(items: readonly SyncReviewItem[]): SyncReviewQueueCounts {
  const counts: SyncReviewQueueCounts = {
    total: items.length,
    imports: 0,
    projectionBlocked: 0,
    conflicts: 0,
    missingObjects: 0,
  };

  for (const item of items) {
    switch (item.kind) {
      case "import":
        counts.imports += 1;
        break;
      case "projectionBlocked":
        counts.projectionBlocked += 1;
        break;
      case "conflict":
        counts.conflicts += 1;
        break;
      case "missingObject":
        counts.missingObjects += 1;
        break;
    }
  }

  return counts;
}

function canOpenReviewDiff(item: SyncReviewItem): boolean {
  return item.kind !== "missingObject";
}

function reviewItemPath(item: SyncReviewItem): string {
  switch (item.kind) {
    case "import":
      return importCandidatePath(item.candidate) ?? item.id;
    case "projectionBlocked":
      return item.normalizedPath;
    case "conflict":
    case "missingObject":
      return issuePath(item.issue) ?? item.id;
  }
}

function reviewItemDescription(item: SyncReviewItem): string {
  switch (item.kind) {
    case "import":
      return humanizeToken(String(item.reason));
    case "projectionBlocked":
      return humanizeToken(String(item.operation));
    case "conflict":
    case "missingObject":
      return humanizeToken(stringField(item.issue, "kind") ?? item.kind);
  }
}

function importCandidatePath(candidate: unknown): string | null {
  const kind = stringField(candidate, "kind");
  if (kind === "externalRename") {
    const from = stringField(candidate, "fromNormalizedPath");
    const to = stringField(candidate, "toNormalizedPath");
    if (from && to) return `${from} -> ${to}`;
  }
  return stringField(candidate, "normalizedPath");
}

function issuePath(issue: unknown): string | null {
  return (
    stringField(issue, "displayPath") ??
    stringField(issue, "normalizedPath") ??
    stringField(issue, "fileId") ??
    firstStringField(issue, "fileIds")
  );
}

function deleteEditFileId(item: SyncReviewItem): string | null {
  if (item.kind !== "conflict") return null;
  if (stringField(item.issue, "kind") !== "deleteEditConflict") return null;
  return stringField(item.issue, "fileId");
}

function renameFileIds(item: SyncReviewItem): string[] {
  if (item.kind === "projectionBlocked") return [item.fileId];
  if (item.kind !== "conflict") return [];
  const issueKind = stringField(item.issue, "kind");
  if (issueKind !== "pathConflict" && issueKind !== "caseConflict") return [];
  return stringArrayField(item.issue, "fileIds");
}

function renameActionKey(item: SyncReviewItem, fileId: string): string {
  return `${item.id}:${fileId}`;
}

function acceptImportCommand(item: SyncReviewItem): SyncReviewResolutionCommand | null {
  if (item.kind !== "import") return null;
  return {
    kind: "acceptImport",
    reviewItemId: item.id,
  };
}

function rejectImportCommand(item: SyncReviewItem): SyncReviewResolutionCommand | null {
  if (item.kind !== "import") return null;
  return {
    kind: "rejectImport",
    reviewItemId: item.id,
  };
}

function keepDeleteCommand(item: SyncReviewItem): SyncReviewResolutionCommand | null {
  const fileId = deleteEditFileId(item);
  if (!fileId) return null;
  return {
    kind: "keepDelete",
    reviewItemId: item.id,
    fileId,
  };
}

function restoreEditedVersionCommand(item: SyncReviewItem): SyncReviewResolutionCommand | null {
  const fileId = deleteEditFileId(item);
  if (!fileId) return null;
  return {
    kind: "restoreEditedVersion",
    reviewItemId: item.id,
    fileId,
  };
}

function renameFileCommand(
  item: SyncReviewItem,
  fileId: string,
  newDisplayPath: string,
): SyncReviewResolutionCommand | null {
  const normalizedDraft = newDisplayPath.trim();
  if (!normalizedDraft || !renameFileIds(item).includes(fileId)) return null;
  return {
    kind: "renameFile",
    reviewItemId: item.id,
    fileId,
    newDisplayPath: normalizedDraft,
  };
}

function retryMissingObjectCommand(item: SyncReviewItem): SyncReviewResolutionCommand | null {
  if (item.kind !== "missingObject") return null;
  return {
    kind: "retryMissingObject",
    reviewItemId: item.id,
  };
}

function recoverySnapshotPath(snapshot: SyncRecoverySnapshot): string {
  return snapshot.displayPath || snapshot.normalizedPath || snapshot.id;
}

function recoverySnapshotDescription(snapshot: SyncRecoverySnapshot): string {
  return `${humanizeToken(snapshot.reason)} · ${formatBytes(snapshot.sizeBytes)} · ${snapshot.contentHash.slice(0, 12)}`;
}

function defaultRecoveryRestorePath(snapshot: SyncRecoverySnapshot): string {
  const path = recoverySnapshotPath(snapshot).trim();
  if (!path) return "recovered.md";
  if (path.toLowerCase().endsWith(".md")) {
    return `${path.slice(0, -3)} recovered.md`;
  }
  return `${path} recovered.md`;
}

function restoreRecoverySnapshotRequest(
  snapshot: SyncRecoverySnapshot,
  targetDisplayPath: string,
): SyncRecoveryRestoreRequest | null {
  const normalizedTarget = targetDisplayPath.trim();
  if (!normalizedTarget) return null;
  return {
    snapshotId: snapshot.id,
    targetDisplayPath: normalizedTarget,
  };
}

function humanizeToken(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
}

function formatBytes(sizeBytes: number): string {
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) return "0 B";
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  const kib = sizeBytes / 1024;
  if (kib < 1024) return `${kib.toFixed(kib >= 10 ? 0 : 1)} KiB`;
  const mib = kib / 1024;
  return `${mib.toFixed(mib >= 10 ? 0 : 1)} MiB`;
}

function stringField(value: unknown, key: string): string | null {
  if (!isRecord(value)) return null;
  const field = value[key];
  return typeof field === "string" && field.trim() ? field : null;
}

function firstStringField(value: unknown, key: string): string | null {
  const strings = stringArrayField(value, key);
  return strings[0] ?? null;
}

function stringArrayField(value: unknown, key: string): string[] {
  if (!isRecord(value)) return [];
  const field = value[key];
  if (!Array.isArray(field)) return [];
  return field.filter((item): item is string => typeof item === "string" && item.trim() !== "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export {
  acceptImportCommand,
  canOpenReviewDiff,
  deleteEditFileId,
  importCandidatePath,
  issuePath,
  keepDeleteCommand,
  rejectImportCommand,
  defaultRecoveryRestorePath,
  recoverySnapshotDescription,
  recoverySnapshotPath,
  renameActionKey,
  renameFileCommand,
  renameFileIds,
  restoreRecoverySnapshotRequest,
  restoreEditedVersionCommand,
  retryMissingObjectCommand,
  reviewQueueCounts,
  reviewItemDescription,
  reviewItemPath,
};
export type { SyncReviewQueueCounts };
