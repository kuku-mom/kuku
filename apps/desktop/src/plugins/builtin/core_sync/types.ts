type SyncPhase =
  | "notConfigured"
  | "disabled"
  | "idle"
  | "planning"
  | "packing"
  | "transferring"
  | "publishing"
  | "applying"
  | "error";

type SyncErrorCategory =
  | "notConfigured"
  | "loginRequired"
  | "permissionRequired"
  | "syncDisabled"
  | "offline"
  | "quotaExceeded"
  | "passphraseFailed"
  | "server"
  | "unknown";

interface SyncCommandError {
  category: SyncErrorCategory;
  message: string;
}

type SyncTransferDirection = "idle" | "upload" | "download" | "both";

interface SyncTransferStatus {
  active: boolean;
  direction: SyncTransferDirection;
  retrying: boolean;
  uploadTotalObjects: number;
  uploadCompletedObjects: number;
  uploadFailedObjects: number;
  downloadTotalObjects: number;
  downloadCompletedObjects: number;
  downloadFailedObjects: number;
  retryAttempt?: number;
  maxAttempts?: number;
  nextRetryAtMs?: number;
  lastTransferError?: string;
}

interface SyncVaultConfig {
  vaultId: string;
  rootPath: string;
  accountKeyId?: string;
  remoteWorkspaceId: string;
  workspaceName?: string;
  deviceId: string;
  deviceName?: string;
  rememberWorkspaceKey: boolean;
  passphrase?: string;
}

interface SyncRuntimeStatus {
  configured: boolean;
  enabled: boolean;
  phase: SyncPhase;
  vaultId?: string;
  rootPath?: string;
  vaultName?: string;
  accountKeyId?: string;
  remoteWorkspaceId?: string;
  workspaceName?: string;
  deviceId?: string;
  deviceName?: string;
  rememberWorkspaceKey: boolean;
  lastError?: string;
  lastErrorCategory?: SyncErrorCategory;
  lastSyncedAtMs?: number;
  pendingUploads: number;
  pendingDownloads: number;
  transfer: SyncTransferStatus;
  conflictCount: number;
  updatedAtMs: number;
}

interface SyncRemoteStatus {
  workspaceId: string;
  remoteHeadCommitId: string;
  remoteHeadVersion: number;
  latestCheckpointCommitId: string;
  localRemoteHeadCommitId?: string;
  localHeadCommitId?: string;
  hasRemoteChanges: boolean;
  checkedAtMs: number;
}

interface SyncWorkspaceSummary {
  workspaceId: string;
  name: string;
  current: boolean;
  headVersion: number;
  metadataVersion: number;
  workspaceKeyVersion: number;
}

interface SyncAccountRecoveryState {
  configured: boolean;
  accountKeyId?: string;
  recoveryPhraseConfigured: boolean;
  applied: boolean;
  recoveryPhraseSaved: boolean;
}

interface SyncRenameWorkspaceInput {
  workspaceId: string;
  name: string;
  expectedMetadataVersion: number;
  passphrase?: string;
}

interface SyncCreateWorkspaceInput {
  name?: string;
  passphrase?: string;
}

interface SyncStatusEvent {
  status: SyncRuntimeStatus;
}

interface SyncConflictSummary {
  conflictId: string;
  path: string;
  conflictPath: string;
  baseCommitId?: string;
  remoteCommitId?: string;
  status: string;
  createdAtMs: number;
}

interface SyncDiagnosticsSnapshot {
  generatedAtMs: number;
  engine: string;
  status: SyncDiagnosticsStatus;
  autoSync: unknown;
  legacyConflictCount: number;
  legacyConflictErrorCategory?: SyncErrorCategory;
  review: SyncReviewDiagnostics;
  store: SyncStoreDiagnostics;
}

interface SyncDiagnosticsStatus {
  configured: boolean;
  enabled: boolean;
  phase: SyncPhase;
  rememberWorkspaceKey: boolean;
  hasVaultId: boolean;
  hasRootPath: boolean;
  hasAccountKeyId: boolean;
  hasRemoteWorkspaceId: boolean;
  hasDeviceId: boolean;
  lastErrorCategory?: SyncErrorCategory;
  lastSyncedAtMs?: number;
  pendingUploads: number;
  pendingDownloads: number;
  transfer: SyncDiagnosticsTransferStatus;
  conflictCount: number;
  updatedAtMs: number;
}

interface SyncDiagnosticsTransferStatus {
  active: boolean;
  direction: SyncTransferDirection;
  retrying: boolean;
  uploadTotalObjects: number;
  uploadCompletedObjects: number;
  uploadFailedObjects: number;
  downloadTotalObjects: number;
  downloadCompletedObjects: number;
  downloadFailedObjects: number;
  retryAttempt?: number;
  maxAttempts?: number;
  nextRetryAtMs?: number;
  hasLastTransferError: boolean;
}

interface SyncReviewDiagnostics {
  available: boolean;
  blocksFullySynced: boolean;
  itemCount: number;
  importCount: number;
  projectionBlockedCount: number;
  conflictCount: number;
  missingObjectCount: number;
  errorCategory?: SyncErrorCategory;
}

interface SyncStoreDiagnostics {
  available: boolean;
  missingManifest: boolean;
  missingTextDocRecordCount: number;
  errorCategory?: SyncErrorCategory;
}

type SyncReviewItem =
  | {
      kind: "import";
      id: string;
      reason: string;
      candidate: unknown;
    }
  | {
      kind: "projectionBlocked";
      id: string;
      fileId: string;
      normalizedPath: string;
      operation: string;
      preflight: unknown;
    }
  | {
      kind: "conflict";
      id: string;
      issue: unknown;
    }
  | {
      kind: "missingObject";
      id: string;
      issue: unknown;
    };

interface SyncReviewQueueSnapshot {
  blocksFullySynced: boolean;
  items: SyncReviewItem[];
}

type SyncReviewDiffKind =
  | "importCreate"
  | "importModify"
  | "importDelete"
  | "importRename"
  | "projectionWrite"
  | "projectionDelete"
  | "deleteEditConflict";

interface SyncReviewDiffPayload {
  reviewItemId: string;
  kind: SyncReviewDiffKind;
  path: string;
  oldMarkdown: string;
  newMarkdown: string;
}

type SyncRecoverySnapshotKind =
  | "current"
  | "tombstone"
  | "deleteEditTombstone"
  | "deleteEditCurrent";

type SyncRecoverySnapshotReason =
  | "activeMaterialized"
  | "tombstonedFile"
  | "deleteEditConflict";

interface SyncRecoverySnapshot {
  id: string;
  kind: SyncRecoverySnapshotKind;
  reason: SyncRecoverySnapshotReason;
  fileId: string;
  incarnationId: string;
  displayPath: string;
  normalizedPath: string;
  textDocId: string;
  contentHash: string;
  sizeBytes: number;
  content: string;
}

type SyncRecoveryUnavailableReason = "missingTextDoc" | "missingBlob";

interface SyncRecoveryUnavailable {
  id: string;
  reason: SyncRecoveryUnavailableReason;
  fileId: string;
  displayPath?: string;
  normalizedPath?: string;
  textDocId?: string;
  blobRef?: string;
}

interface SyncRecoverySnapshotSet {
  snapshots: SyncRecoverySnapshot[];
  unavailable: SyncRecoveryUnavailable[];
}

interface SyncRecoveryRestoreRequest {
  snapshotId: string;
  targetDisplayPath: string;
}

type SyncReviewResolutionCommand =
  | {
      kind: "acceptImport";
      reviewItemId: string;
    }
  | {
      kind: "rejectImport";
      reviewItemId: string;
    }
  | {
      kind: "keepDelete";
      reviewItemId: string;
      fileId: string;
    }
  | {
      kind: "restoreEditedVersion";
      reviewItemId: string;
      fileId: string;
    }
  | {
      kind: "renameFile";
      reviewItemId: string;
      fileId: string;
      newDisplayPath: string;
    }
  | {
      kind: "retryMissingObject";
      reviewItemId: string;
    };

type SyncAuthState = "ready" | "loginRequired" | "permissionRequired";

export type {
  SyncAccountRecoveryState,
  SyncAuthState,
  SyncCommandError,
  SyncCreateWorkspaceInput,
  SyncDiagnosticsSnapshot,
  SyncDiagnosticsStatus,
  SyncDiagnosticsTransferStatus,
  SyncErrorCategory,
  SyncConflictSummary,
  SyncPhase,
  SyncRecoveryRestoreRequest,
  SyncRecoverySnapshot,
  SyncRecoverySnapshotKind,
  SyncRecoverySnapshotReason,
  SyncRecoverySnapshotSet,
  SyncRecoveryUnavailable,
  SyncRecoveryUnavailableReason,
  SyncRemoteStatus,
  SyncRenameWorkspaceInput,
  SyncReviewDiagnostics,
  SyncReviewDiffKind,
  SyncReviewDiffPayload,
  SyncReviewItem,
  SyncReviewQueueSnapshot,
  SyncReviewResolutionCommand,
  SyncRuntimeStatus,
  SyncStatusEvent,
  SyncStoreDiagnostics,
  SyncTransferDirection,
  SyncTransferStatus,
  SyncVaultConfig,
  SyncWorkspaceSummary,
};
