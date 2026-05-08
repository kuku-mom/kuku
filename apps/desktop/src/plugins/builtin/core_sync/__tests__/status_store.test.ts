import { beforeEach, describe, expect, it, vi } from "vitest";

import { onEvent } from "~/plugins/events";

import {
  applySyncConflicts,
  applySyncRemoteStatus,
  applySyncStatus,
  emulateSyncStatus,
  resetSyncStatus,
  refreshSyncStatus,
  stopSyncEmulation,
  syncConflicts,
  syncRemoteStatus,
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
      vaultName: "vault",
      accountKeyId: "account_key_1",
      remoteWorkspaceId: "workspace_1",
      workspaceName: "Product Notes",
      deviceId: "device_1",
      deviceName: "Mansuiki Mac",
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
    expect(syncStatus.vaultName).toBe("vault");
    expect(syncStatus.accountKeyId).toBe("account_key_1");
    expect(syncStatus.workspaceName).toBe("Product Notes");
    expect(syncStatus.deviceName).toBe("Mansuiki Mac");
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

  it("keeps the latest remote status until the workspace changes", () => {
    applySyncRemoteStatus({
      workspaceId: "workspace_1",
      remoteHeadCommitId: "commit_remote",
      remoteHeadVersion: 3,
      latestCheckpointCommitId: "checkpoint_1",
      hasRemoteChanges: false,
      checkedAtMs: 10,
    });

    applySyncStatus({
      configured: true,
      enabled: true,
      phase: "idle",
      remoteWorkspaceId: "workspace_1",
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
      updatedAtMs: 11,
    });
    expect(syncRemoteStatus()?.remoteHeadVersion).toBe(3);

    applySyncStatus({
      configured: true,
      enabled: true,
      phase: "idle",
      remoteWorkspaceId: "workspace_2",
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
      updatedAtMs: 12,
    });
    expect(syncRemoteStatus()).toBeNull();
  });

  it("reconciles pending downloads from remote status", () => {
    applySyncStatus({
      configured: true,
      enabled: true,
      phase: "idle",
      remoteWorkspaceId: "workspace_1",
      rememberWorkspaceKey: true,
      pendingUploads: 0,
      pendingDownloads: 11,
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
      updatedAtMs: 11,
    });

    applySyncRemoteStatus({
      workspaceId: "workspace_1",
      remoteHeadCommitId: "commit_1",
      remoteHeadVersion: 1,
      latestCheckpointCommitId: "commit_1",
      hasRemoteChanges: false,
      checkedAtMs: 12,
    });

    expect(syncStatus.pendingDownloads).toBe(0);

    applySyncRemoteStatus({
      workspaceId: "workspace_1",
      remoteHeadCommitId: "commit_2",
      remoteHeadVersion: 2,
      latestCheckpointCommitId: "commit_2",
      hasRemoteChanges: true,
      checkedAtMs: 13,
    });

    expect(syncStatus.pendingDownloads).toBe(1);
  });

  it("loads the initial remote status during runtime status refresh", async () => {
    const refreshedStatus: SyncRuntimeStatus = {
      configured: true,
      enabled: true,
      phase: "idle",
      remoteWorkspaceId: "workspace_1",
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
      updatedAtMs: 20,
    };
    const getRemoteStatus = vi.fn(async () => ({
      workspaceId: "workspace_1",
      remoteHeadCommitId: "commit_remote",
      remoteHeadVersion: 4,
      latestCheckpointCommitId: "checkpoint_1",
      hasRemoteChanges: true,
      checkedAtMs: 30,
    }));
    const getCachedRemoteStatus = vi.fn(async () => ({
      workspaceId: "workspace_1",
      remoteHeadCommitId: "commit_cached",
      remoteHeadVersion: 3,
      latestCheckpointCommitId: "checkpoint_cached",
      hasRemoteChanges: false,
      checkedAtMs: 25,
    }));
    const service: SyncService = {
      async getStatus() {
        return refreshedStatus;
      },
      getRemoteStatus,
      getCachedRemoteStatus,
      async getSavedPassphrase() {
        return null;
      },
      async generateRecoveryPhrase() {
        return "alpha beta gamma";
      },
      async getSavedRecoveryPhrase() {
        return null;
      },
      async getAccountRecoveryState() {
        return {
          configured: false,
          recoveryPhraseConfigured: false,
          applied: false,
          recoveryPhraseSaved: false,
        };
      },
      async listWorkspaces() {
        return [];
      },
      async createWorkspace() {
        throw new Error("not implemented");
      },
      async renameWorkspace() {
        throw new Error("not implemented");
      },
      async deleteWorkspace() {
        return refreshedStatus;
      },
      async saveRecoveryPhraseFile() {
        return true;
      },
      async configureVault() {
        return refreshedStatus;
      },
      async disconnectVault() {
        return refreshedStatus;
      },
      async rebuildVaultState() {
        return refreshedStatus;
      },
      async setEnabled() {
        return refreshedStatus;
      },
      async runOnce() {
        return refreshedStatus;
      },
      async listConflicts() {
        return [];
      },
      async authState() {
        return "ready";
      },
    };

    await refreshSyncStatus(service);
    await refreshSyncStatus(service);

    expect(getCachedRemoteStatus).toHaveBeenCalledTimes(1);
    expect(getRemoteStatus).toHaveBeenCalledTimes(1);
    expect(syncRemoteStatus()?.remoteHeadVersion).toBe(4);
    expect(syncRemoteStatus()?.hasRemoteChanges).toBe(true);
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
      async getCachedRemoteStatus() {
        return null;
      },
      async getSavedPassphrase() {
        return null;
      },
      async generateRecoveryPhrase() {
        return "alpha beta gamma";
      },
      async getSavedRecoveryPhrase() {
        return null;
      },
      async getAccountRecoveryState() {
        return {
          configured: false,
          recoveryPhraseConfigured: false,
          applied: false,
          recoveryPhraseSaved: false,
        };
      },
      async listWorkspaces() {
        return [];
      },
      async createWorkspace() {
        throw new Error("not implemented");
      },
      async renameWorkspace() {
        throw new Error("not implemented");
      },
      async deleteWorkspace() {
        return idleStatus;
      },
      async saveRecoveryPhraseFile() {
        return true;
      },
      async configureVault() {
        return idleStatus;
      },
      async disconnectVault() {
        return idleStatus;
      },
      async rebuildVaultState() {
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
