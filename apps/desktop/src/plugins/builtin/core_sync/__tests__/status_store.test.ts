import { beforeEach, describe, expect, it } from "vitest";

import { onEvent } from "~/plugins/events";

import {
  applySyncConflicts,
  applySyncStatus,
  resetSyncStatus,
  syncConflicts,
  syncStatus,
} from "../status_store";

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
      lastSyncedAtMs: 10,
      pendingUploads: 1,
      pendingDownloads: 2,
      conflictCount: 3,
      updatedAtMs: 11,
    });

    expect(syncStatus.configured).toBe(true);
    expect(syncStatus.phase).toBe("idle");
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
});
