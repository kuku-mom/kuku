import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { createStore } from "solid-js/store";

import { emitEvent } from "~/plugins/events";
import type { Disposer } from "~/plugins/types";

import type { SyncConflictSummary, SyncRuntimeStatus, SyncStatusEvent } from "./types";
import type { SyncService } from "./service";

const DEFAULT_STATUS: SyncRuntimeStatus = {
  configured: false,
  enabled: false,
  phase: "notConfigured",
  rememberWorkspaceKey: true,
  pendingUploads: 0,
  pendingDownloads: 0,
  conflictCount: 0,
  updatedAtMs: 0,
};

const [syncStatus, setSyncStatus] = createStore<SyncRuntimeStatus>({ ...DEFAULT_STATUS });
const [syncConflicts, setSyncConflicts] = createStore<SyncConflictSummary[]>([]);

function applySyncStatus(status: SyncRuntimeStatus): void {
  const previousUpdatedAt = syncStatus.updatedAtMs;
  setSyncStatus({
    configured: status.configured,
    enabled: status.enabled,
    phase: status.phase,
    vaultId: status.vaultId,
    rootPath: status.rootPath,
    remoteWorkspaceId: status.remoteWorkspaceId,
    deviceId: status.deviceId,
    rememberWorkspaceKey: status.rememberWorkspaceKey,
    lastError: status.lastError,
    lastSyncedAtMs: status.lastSyncedAtMs,
    pendingUploads: status.pendingUploads,
    pendingDownloads: status.pendingDownloads,
    conflictCount: status.conflictCount,
    updatedAtMs: status.updatedAtMs,
  });

  if (status.updatedAtMs !== previousUpdatedAt) {
    emitEvent("sync:updated", status);
  }
}

function applySyncConflicts(conflicts: SyncConflictSummary[]): void {
  setSyncConflicts(conflicts);
  setSyncStatus("conflictCount", conflicts.length);
}

function resetSyncStatus(): void {
  applySyncStatus({ ...DEFAULT_STATUS });
  applySyncConflicts([]);
}

async function refreshSyncStatus(service: SyncService): Promise<void> {
  try {
    applySyncStatus(await service.getStatus());
    applySyncConflicts(await service.listConflicts());
  } catch {
    // The settings page has its own explicit error surface for user-triggered actions.
  }
}

function startSyncStatusBridge(service: SyncService): Disposer {
  let eventUnlisten: UnlistenFn | null = null;
  let disposed = false;
  void refreshSyncStatus(service);
  void listen<SyncStatusEvent>("sync:status-changed", (event) => {
    applySyncStatus(event.payload.status);
    void service
      .listConflicts()
      .then(applySyncConflicts)
      .catch(() => undefined);
  }).then((unlisten) => {
    if (disposed) {
      unlisten();
    } else {
      eventUnlisten = unlisten;
    }
  });

  const timer = window.setInterval(() => {
    void refreshSyncStatus(service);
  }, 5000);

  return () => {
    disposed = true;
    window.clearInterval(timer);
    eventUnlisten?.();
  };
}

export {
  applySyncConflicts,
  applySyncStatus,
  refreshSyncStatus,
  resetSyncStatus,
  startSyncStatusBridge,
  syncConflicts,
  syncStatus,
};
