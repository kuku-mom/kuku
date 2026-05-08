import { describe, expect, it } from "vitest";

import { transferStatusLabel } from "../transfer_status";
import type { SyncTransferStatus } from "../types";

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

describe("transfer status label", () => {
  it("shows none for inactive transfer", () => {
    expect(transferStatusLabel(idleTransfer)).toBe("None");
  });

  it("shows upload object progress", () => {
    expect(
      transferStatusLabel({
        ...idleTransfer,
        active: true,
        direction: "upload",
        uploadTotalObjects: 5,
        uploadCompletedObjects: 2,
      }),
    ).toBe("Uploading 2 / 5");
  });

  it("shows download retry progress", () => {
    expect(
      transferStatusLabel({
        ...idleTransfer,
        active: true,
        direction: "download",
        retrying: true,
        retryAttempt: 2,
        maxAttempts: 3,
      }),
    ).toBe("Retrying download 2 / 3");
  });
});
