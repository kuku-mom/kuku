import { beforeEach, describe, expect, it, vi } from "vitest";

import { onEvent } from "~/plugins/events";

import {
  applySyncConflicts,
  applySyncStatus,
  emulateSyncStatus,
  resetSyncStatus,
  refreshSyncStatus,
  stopSyncEmulation,
  syncConflicts,
  syncStatus,
} from "../status_store";
import type { SyncService } from "../service";
import type { SyncRuntimeStatus } from "../types";

describe("sync status store", () => {
  beforeEach(() => {
    resetSyncStatus();
  });

  it("applies status snapshots and emits updates", () => {
    const updates: number[] = [];
    const stop = onEvent("sync:updated", (status) => {
      if (
        typeof status === "object" &&
        status !== null &&
        "updatedAtMs" in status &&
        typeof status.updatedAtMs === "number"
      ) {
        updates.push(status.updatedAtMs);
      }
    });

    applySyncStatus({
      configured: true,
      enabled: true,
      phase: "idle",
      vaultId: "vault_1",
      rootPath: "/tmp/vault",
      remoteWorkspaceId: "workspace_1",
      deviceId: "device_1",
      rememberWorkspaceKey: true,
      lastError: "sync is disabled on this server",
      lastErrorCategory: "syncDisabled",
      lastSyncedAtMs: 10,
      pendingUploads: 1,
      pendingDownloads: 2,
      transfer: {
        active: true,
        direction: "upload",
        retrying: false,
        uploadTotalObjects: 4,
        uploadCompletedObjects: 1,
        uploadFailedObjects: 0,
        downloadTotalObjects: 0,
        downloadCompletedObjects: 0,
        downloadFailedObjects: 0,
      },
      conflictCount: 3,
      updatedAtMs: 11,
    });

    expect(syncStatus.configured).toBe(true);
    expect(syncStatus.phase).toBe("idle");
    expect(syncStatus.lastErrorCategory).toBe("syncDisabled");
    expect(syncStatus.transfer.direction).toBe("upload");
    expect(syncStatus.transfer.uploadCompletedObjects).toBe(1);
    expect(syncStatus.conflictCount).toBe(3);
    expect(updates).toEqual([11]);
    stop();
  });

  it("keeps conflict count aligned with conflict list", () => {
    applySyncConflicts([
      {
        conflictId: "conflict_1",
        path: "a.md",
        conflictPath: "a.conflict-19700101-000000.md",
        status: "open",
        createdAtMs: 1,
      },
    ]);

    expect(syncConflicts).toHaveLength(1);
    expect(syncStatus.conflictCount).toBe(1);
  });

  it("keeps emulated status from being overwritten by refresh", async () => {
    emulateSyncStatus({
      phase: "transferring",
      transfer: {
        active: true,
        direction: "upload",
        retrying: false,
        uploadTotalObjects: 4,
        uploadCompletedObjects: 2,
        uploadFailedObjects: 0,
        downloadTotalObjects: 0,
        downloadCompletedObjects: 0,
        downloadFailedObjects: 0,
      },
    });
    const getStatus = vi.fn();
    const idleStatus: SyncRuntimeStatus = {
      configured: true,
      enabled: true,
      phase: "idle",
      rememberWorkspaceKey: true,
      pendingUploads: 0,
      pendingDownloads: 0,
      transfer: {
        active: false,
        direction: "idle",
        retrying: false,
        uploadTotalObjects: 0,
        uploadCompletedObjects: 0,
        uploadFailedObjects: 0,
        downloadTotalObjects: 0,
        downloadCompletedObjects: 0,
        downloadFailedObjects: 0,
      },
      conflictCount: 0,
      updatedAtMs: 100,
    };
    const service: SyncService = {
      async getStatus() {
        getStatus();
        return idleStatus;
      },
      async getRemoteStatus() {
        return {
          workspaceId: "workspace",
          remoteHeadCommitId: "commit-remote",
          remoteHeadVersion: 1,
          latestCheckpointCommitId: "commit-remote",
          hasRemoteChanges: false,
          checkedAtMs: 1,
        };
      },
      async configureVault() {
        return idleStatus;
      },
      async setEnabled() {
        return idleStatus;
      },
      async runOnce() {
        return idleStatus;
      },
      async listConflicts() {
        return [];
      },
      async authState() {
        return "ready";
      },
    };

    await refreshSyncStatus(service);

    expect(getStatus).not.toHaveBeenCalled();
    expect(syncStatus.phase).toBe("transferring");
    expect(syncStatus.transfer.uploadCompletedObjects).toBe(2);
  });

  it("stops emulation and resets status", () => {
    emulateSyncStatus({ phase: "planning" });

    stopSyncEmulation();

    expect(syncStatus.configured).toBe(false);
    expect(syncStatus.phase).toBe("notConfigured");
    expect(syncStatus.transfer.direction).toBe("idle");
  });
});
