import { describe, expect, it } from "vitest";

import { SYNCED_IDLE_DELAY_MS, syncIndicatorState } from "../sync_status_indicator_state";
import type { SyncRuntimeStatus, SyncTransferStatus } from "../types";

const idleTransfer: SyncTransferStatus = {
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

type StatusOverrides = Omit<Partial<SyncRuntimeStatus>, "transfer"> & {
  transfer?: Partial<SyncTransferStatus>;
};

function status(overrides: StatusOverrides = {}): SyncRuntimeStatus {
  const { transfer, ...statusOverrides } = overrides;

  return {
    configured: false,
    enabled: false,
    phase: "notConfigured",
    rememberWorkspaceKey: true,
    pendingUploads: 0,
    pendingDownloads: 0,
    conflictCount: 0,
    updatedAtMs: 1,
    ...statusOverrides,
    transfer: {
      ...idleTransfer,
      ...transfer,
    },
  };
}

describe("sync indicator state", () => {
  it("hides when sync is not configured and has no actionable state", () => {
    expect(syncIndicatorState(status()).kind).toBe("hidden");
  });

  it("shows idle when configured sync is enabled", () => {
    const indicator = syncIndicatorState(
      status({ configured: true, enabled: true, phase: "idle" }),
    );

    expect(indicator.kind).toBe("idle");
    expect(indicator.tone).toBe("neutral");
  });

  it("shows pending when local or remote work is queued", () => {
    const indicator = syncIndicatorState(
      status({ configured: true, enabled: true, phase: "idle", pendingUploads: 1 }),
    );

    expect(indicator.kind).toBe("pending");
    expect(indicator.active).toBe(false);
    expect(indicator.tone).toBe("neutral");
  });

  it("delays the synced state briefly after a completed sync", () => {
    const syncedAt = 10_000;

    expect(
      syncIndicatorState(
        status({ configured: true, enabled: true, phase: "idle", lastSyncedAtMs: syncedAt }),
        syncedAt + SYNCED_IDLE_DELAY_MS - 1,
      ).kind,
    ).toBe("syncing");
    expect(
      syncIndicatorState(
        status({ configured: true, enabled: true, phase: "idle", lastSyncedAtMs: syncedAt }),
        syncedAt + SYNCED_IDLE_DELAY_MS,
      ).kind,
    ).toBe("idle");
  });

  it("prioritizes typed errors over conflicts and transfer state", () => {
    expect(
      syncIndicatorState(
        status({
          configured: true,
          enabled: true,
          phase: "transferring",
          lastErrorCategory: "quotaExceeded",
          conflictCount: 2,
          transfer: {
            active: true,
            direction: "upload",
            retrying: false,
            uploadTotalObjects: 3,
          },
        }),
      ).kind,
    ).toBe("quotaExceeded");
  });

  it("keeps active transfer states visually neutral", () => {
    const indicator = syncIndicatorState(
      status({
        configured: true,
        enabled: true,
        phase: "transferring",
        transfer: {
          active: true,
          direction: "upload",
          retrying: false,
          uploadTotalObjects: 3,
        },
      }),
    );

    expect(indicator.kind).toBe("uploading");
    expect(indicator.tone).toBe("neutral");
  });

  it("shows conflicts before generic syncing", () => {
    expect(
      syncIndicatorState(
        status({
          configured: true,
          enabled: true,
          phase: "planning",
          conflictCount: 1,
        }),
      ).kind,
    ).toBe("conflict");
  });

  it("shows object-count transfer direction", () => {
    expect(
      syncIndicatorState(
        status({
          configured: true,
          enabled: true,
          phase: "transferring",
          transfer: {
            active: true,
            direction: "download",
            retrying: false,
            downloadTotalObjects: 4,
            downloadCompletedObjects: 1,
          },
        }),
      ).kind,
    ).toBe("downloading");
  });

  it("shows retry direction when transfer is retrying", () => {
    expect(
      syncIndicatorState(
        status({
          configured: true,
          enabled: true,
          phase: "transferring",
          transfer: {
            active: true,
            direction: "upload",
            retrying: true,
            retryAttempt: 2,
            maxAttempts: 3,
          },
        }),
      ).kind,
    ).toBe("retryingUpload");
  });
});
