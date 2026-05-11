import { describe, expect, it } from "vitest";

import { syncAccountKeyToEncryptionKeyInfo } from "./dashboard";

describe("dashboard api mapping", () => {
  it("maps missing sync account key state to an unconfigured dashboard state", () => {
    expect(syncAccountKeyToEncryptionKeyInfo()).toEqual({
      accountKeyId: "",
      configured: false,
      cryptoVersion: "",
      updatedAt: null,
    });
  });

  it("maps sync account key metadata without exposing secret key material", () => {
    expect(
      syncAccountKeyToEncryptionKeyInfo({
        $typeName: "kuku.sync.v1.SyncAccountKey",
        accountKeyId: "account_123",
        cryptoVersion: "kuku-sync-v1",
        createdAt: {
          $typeName: "google.protobuf.Timestamp",
          nanos: 0,
          seconds: 1_776_883_200n,
        },
        updatedAt: {
          $typeName: "google.protobuf.Timestamp",
          nanos: 0,
          seconds: BigInt(Date.parse("2026-04-23T00:00:00.000Z") / 1000),
        },
      }),
    ).toEqual({
      accountKeyId: "account_123",
      configured: true,
      cryptoVersion: "kuku-sync-v1",
      updatedAt: new Date("2026-04-23T00:00:00.000Z"),
    });
  });
});
