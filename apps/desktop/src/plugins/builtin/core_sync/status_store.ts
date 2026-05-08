import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { createSignal } from "solid-js";
import { createStore } from "solid-js/store";

import { emitEvent } from "~/plugins/events";
import type { Disposer } from "~/plugins/types";
import { createWatcherRefreshScheduler } from "~/stores/watcher_refresh";
import type { FileChangeEvent } from "~/lib/vault_fs";

import type {
  SyncConflictSummary,
  SyncRemoteStatus,
  SyncRuntimeStatus,
  SyncStatusEvent,
  SyncTransferStatus,
} from "./types";
import type { SyncService, SyncStatusOptions } from "./service";

const DEFAULT_TRANSFER_STATUS: SyncTransferStatus = {
  active: false,
  direction: "idle",
  retrying: false,
  uploadTotalObjects: 0,
  uploadCompletedObjects: 0,
  uploadFailedObjects: 0,
  downloadTotalObjects: 0,
  downloadCompletedObjects: 0,
  downloadFailedObjects: 0,
};

const DEFAULT_STATUS: SyncRuntimeStatus = {
  configured: false,
  enabled: false,
  phase: "notConfigured",
  rememberWorkspaceKey: true,
  pendingUploads: 0,
  pendingDownloads: 0,
  transfer: { ...DEFAULT_TRANSFER_STATUS },
  conflictCount: 0,
  updatedAtMs: 0,
};

const [syncStatus, setSyncStatus] = createStore<SyncRuntimeStatus>({ ...DEFAULT_STATUS });
const [syncConflicts, setSyncConflicts] = createStore<SyncConflictSummary[]>([]);
const [syncRemoteStatus, setSyncRemoteStatus] = createSignal<SyncRemoteStatus | null>(null);
let syncEmulationEnabled = false;
let syncEmulationRunId = 0;
let remoteStatusRefreshInFlight = false;
let remoteStatusNeedsLiveRefresh = false;

function applySyncStatus(status: SyncRuntimeStatus): void {
  const previousUpdatedAt = syncStatus.updatedAtMs;
  setSyncStatus({
    configured: status.configured,
    enabled: status.enabled,
    phase: status.phase,
    vaultId: status.vaultId,
    rootPath: status.rootPath,
    vaultName: status.vaultName,
    accountKeyId: status.accountKeyId,
    remoteWorkspaceId: status.remoteWorkspaceId,
    workspaceName: status.workspaceName,
    deviceId: status.deviceId,
    deviceName: status.deviceName,
    rememberWorkspaceKey: status.rememberWorkspaceKey,
    lastError: status.lastError,
    lastErrorCategory: status.lastErrorCategory,
    lastSyncedAtMs: status.lastSyncedAtMs,
    pendingUploads: status.pendingUploads,
    pendingDownloads: status.pendingDownloads,
    transfer: { ...(status.transfer ?? DEFAULT_TRANSFER_STATUS) },
    conflictCount: status.conflictCount,
    updatedAtMs: status.updatedAtMs,
  });

  if (status.updatedAtMs !== previousUpdatedAt) {
    emitEvent("sync:updated", status);
  }

  if (
    !status.configured ||
    (syncRemoteStatus()?.workspaceId &&
      syncRemoteStatus()?.workspaceId !== status.remoteWorkspaceId)
  ) {
    setSyncRemoteStatus(null);
  }
}

function applySyncConflicts(conflicts: SyncConflictSummary[]): void {
  setSyncConflicts(conflicts);
  setSyncStatus("conflictCount", conflicts.length);
}

function applySyncRemoteStatus(status: SyncRemoteStatus | null): void {
  remoteStatusNeedsLiveRefresh = false;
  setSyncRemoteStatus(status);
  if (
    status &&
    syncStatus.configured &&
    syncStatus.enabled &&
    syncStatus.remoteWorkspaceId === status.workspaceId
  ) {
    setSyncStatus("pendingDownloads", status.hasRemoteChanges ? 1 : 0);
  }
}

function applyCachedSyncRemoteStatus(status: SyncRemoteStatus): void {
  remoteStatusNeedsLiveRefresh = true;
  setSyncRemoteStatus(status);
}

function resetSyncStatus(): void {
  syncEmulationEnabled = false;
  syncEmulationRunId += 1;
  applySyncStatus({ ...DEFAULT_STATUS });
  applySyncConflicts([]);
  applySyncRemoteStatus(null);
}

function shouldRefreshRemoteStatus(status: SyncRuntimeStatus): boolean {
  if (!status.configured || !status.enabled || !status.remoteWorkspaceId) return false;
  const remoteStatus = syncRemoteStatus();
  return (
    remoteStatusNeedsLiveRefresh ||
    !remoteStatus ||
    remoteStatus.workspaceId !== status.remoteWorkspaceId
  );
}

async function refreshMissingRemoteStatus(
  service: SyncService,
  status: SyncRuntimeStatus,
): Promise<void> {
  if (syncEmulationEnabled || remoteStatusRefreshInFlight || !shouldRefreshRemoteStatus(status)) {
    return;
  }

  remoteStatusRefreshInFlight = true;
  try {
    try {
      const cachedRemoteStatus = await service.getCachedRemoteStatus();
      if (
        cachedRemoteStatus &&
        syncStatus.configured &&
        syncStatus.remoteWorkspaceId === cachedRemoteStatus.workspaceId
      ) {
        applyCachedSyncRemoteStatus(cachedRemoteStatus);
      }
    } catch {
      // Cached status is only an immediate display hint.
    }

    const remoteStatus = await service.getRemoteStatus();
    if (syncStatus.configured && syncStatus.remoteWorkspaceId === remoteStatus.workspaceId) {
      applySyncRemoteStatus(remoteStatus);
    }
  } catch {
    // Startup refresh is best-effort; explicit widget refresh still surfaces auth/network errors.
  } finally {
    remoteStatusRefreshInFlight = false;
  }
}

async function refreshSyncStatus(
  service: SyncService,
  options?: SyncStatusOptions,
): Promise<boolean> {
  if (syncEmulationEnabled) return true;
  try {
    const status = await service.getStatus(options);
    applySyncStatus(status);
    applySyncConflicts(await service.listConflicts());
    await refreshMissingRemoteStatus(service, status);
    return true;
  } catch {
    // The settings page has its own explicit error surface for user-triggered actions.
    return false;
  }
}

function startSyncStatusBridge(service: SyncService): Disposer {
  let eventUnlisten: UnlistenFn | null = null;
  let vaultUnlisten: UnlistenFn | null = null;
  let disposed = false;
  const vaultRefreshScheduler = createWatcherRefreshScheduler(async () => {
    await refreshSyncStatus(service, { scanLocal: true });
  }, 250);
  void refreshSyncStatus(service, { scanLocal: true });
  void listen<SyncStatusEvent>("sync:status-changed", (event) => {
    if (syncEmulationEnabled) return;
    applySyncStatus(event.payload.status);
    void service
      .listConflicts()
      .then(applySyncConflicts)
      .catch(() => undefined);
    void refreshMissingRemoteStatus(service, event.payload.status);
  }).then((unlisten) => {
    if (disposed) {
      unlisten();
    } else {
      eventUnlisten = unlisten;
    }
  });
  void listen<FileChangeEvent>("vault:file-changed", () => {
    if (syncEmulationEnabled) return;
    vaultRefreshScheduler.schedule();
  }).then((unlisten) => {
    if (disposed) {
      unlisten();
    } else {
      vaultUnlisten = unlisten;
    }
  });

  const timer = window.setInterval(() => {
    void refreshSyncStatus(service);
  }, 5000);

  return () => {
    disposed = true;
    vaultRefreshScheduler.cancel();
    window.clearInterval(timer);
    eventUnlisten?.();
    vaultUnlisten?.();
  };
}

function isSyncEmulationEnabled(): boolean {
  return syncEmulationEnabled;
}

function emulateSyncStatus(
  overrides: Partial<SyncRuntimeStatus> = {},
  conflicts: SyncConflictSummary[] = [],
): SyncRuntimeStatus {
  startSyncEmulationRun();
  return applyEmulatedSyncStatus(overrides, conflicts);
}

async function simulateSyncTransfer(): Promise<void> {
  const runId = startSyncEmulationRun();
  applyEmulatedSyncStatus({
    phase: "idle",
    lastSyncedAtMs: Date.now() - 90_000,
  });
  await wait(500);
  if (!isCurrentEmulationRun(runId)) return;

  applyEmulatedSyncStatus({ phase: "planning" });
  await wait(600);
  if (!isCurrentEmulationRun(runId)) return;

  for (let completed = 0; completed <= 3; completed += 1) {
    applyEmulatedSyncStatus({
      phase: "transferring",
      transfer: {
        ...DEFAULT_TRANSFER_STATUS,
        active: true,
        direction: "download",
        retrying: false,
        downloadTotalObjects: 3,
        downloadCompletedObjects: completed,
      },
    });
    await wait(450);
    if (!isCurrentEmulationRun(runId)) return;
  }

  applyEmulatedSyncStatus({
    phase: "transferring",
    transfer: {
      ...DEFAULT_TRANSFER_STATUS,
      active: true,
      direction: "download",
      retrying: true,
      downloadTotalObjects: 3,
      downloadCompletedObjects: 2,
      retryAttempt: 2,
      maxAttempts: 3,
      nextRetryAtMs: Date.now() + 1_200,
      lastTransferError: "object transfer returned HTTP 403: expired",
    },
  });
  await wait(900);
  if (!isCurrentEmulationRun(runId)) return;

  applyEmulatedSyncStatus({ phase: "applying", transfer: { ...DEFAULT_TRANSFER_STATUS } });
  await wait(500);
  if (!isCurrentEmulationRun(runId)) return;

  for (let completed = 0; completed <= 4; completed += 1) {
    applyEmulatedSyncStatus({
      phase: "transferring",
      transfer: {
        ...DEFAULT_TRANSFER_STATUS,
        active: true,
        direction: "upload",
        retrying: false,
        uploadTotalObjects: 4,
        uploadCompletedObjects: completed,
      },
    });
    await wait(400);
    if (!isCurrentEmulationRun(runId)) return;
  }

  applyEmulatedSyncStatus({ phase: "publishing", transfer: { ...DEFAULT_TRANSFER_STATUS } });
  await wait(500);
  if (!isCurrentEmulationRun(runId)) return;

  applyEmulatedSyncStatus({
    phase: "idle",
    lastSyncedAtMs: Date.now(),
    transfer: { ...DEFAULT_TRANSFER_STATUS },
  });
}

function emulateSyncConflict(): SyncRuntimeStatus {
  return emulateSyncStatus({ phase: "idle" }, [
    {
      conflictId: "conflict_emulated",
      path: "Notes/conflicted.md",
      conflictPath: "Notes/conflicted.conflict.md",
      status: "open",
      createdAtMs: Date.now(),
    },
  ]);
}

function emulateSyncError(message = "network transport error"): SyncRuntimeStatus {
  return emulateSyncStatus({
    phase: "error",
    lastError: message,
    lastErrorCategory: "offline",
    transfer: {
      ...DEFAULT_TRANSFER_STATUS,
      lastTransferError: message,
    },
  });
}

function stopSyncEmulation(): void {
  syncEmulationEnabled = false;
  syncEmulationRunId += 1;
  applySyncStatus({ ...DEFAULT_STATUS });
  applySyncConflicts([]);
}

function startSyncEmulationRun(): number {
  syncEmulationEnabled = true;
  syncEmulationRunId += 1;
  return syncEmulationRunId;
}

function isCurrentEmulationRun(runId: number): boolean {
  return syncEmulationEnabled && syncEmulationRunId === runId;
}

function applyEmulatedSyncStatus(
  overrides: Partial<SyncRuntimeStatus> = {},
  conflicts: SyncConflictSummary[] = [],
): SyncRuntimeStatus {
  const transfer = { ...DEFAULT_TRANSFER_STATUS, ...overrides.transfer };
  const status: SyncRuntimeStatus = {
    ...DEFAULT_STATUS,
    configured: true,
    enabled: true,
    phase: "idle",
    vaultId: "vault_emulated",
    rootPath: "/tmp/kuku-sync-emulation",
    remoteWorkspaceId: "workspace_emulated",
    deviceId: "device_emulated",
    rememberWorkspaceKey: true,
    lastSyncedAtMs: Date.now() - 90_000,
    ...overrides,
    transfer,
    conflictCount: conflicts.length,
    updatedAtMs: Date.now(),
  };
  applySyncStatus(status);
  applySyncConflicts(conflicts);
  return status;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (import.meta.env.DEV && typeof window !== "undefined") {
  const syncDebugKey = "__kukuSync";
  Object.assign(window, {
    [syncDebugKey]: {
      state: syncStatus,
      conflicts: syncConflicts,
      simulate: simulateSyncTransfer,
      set: emulateSyncStatus,
      conflict: emulateSyncConflict,
      error: emulateSyncError,
      stop: stopSyncEmulation,
      isEnabled: isSyncEmulationEnabled,
    },
  });
}

export {
  applySyncConflicts,
  applySyncRemoteStatus,
  applySyncStatus,
  emulateSyncConflict,
  emulateSyncError,
  emulateSyncStatus,
  refreshSyncStatus,
  resetSyncStatus,
  simulateSyncTransfer,
  startSyncStatusBridge,
  stopSyncEmulation,
  syncConflicts,
  syncRemoteStatus,
  syncStatus,
};
