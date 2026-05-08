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
  remoteWorkspaceId: string;
  deviceId: string;
  rememberWorkspaceKey: boolean;
  passphrase?: string;
}

interface SyncRuntimeStatus {
  configured: boolean;
  enabled: boolean;
  phase: SyncPhase;
  vaultId?: string;
  rootPath?: string;
  remoteWorkspaceId?: string;
  deviceId?: string;
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

type SyncAuthState = "ready" | "loginRequired" | "permissionRequired";

export type {
  SyncAuthState,
  SyncCommandError,
  SyncErrorCategory,
  SyncConflictSummary,
  SyncPhase,
  SyncRemoteStatus,
  SyncRuntimeStatus,
  SyncStatusEvent,
  SyncTransferDirection,
  SyncTransferStatus,
  SyncVaultConfig,
};
