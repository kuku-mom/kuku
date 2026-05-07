import { describe, expect, it } from "vitest";

import { defaultVaultId, mapSyncError } from "./service";

describe("core sync service helpers", () => {
  it("derives stable vault ids from root paths", () => {
    expect(defaultVaultId("/tmp/vault")).toBe(defaultVaultId("/tmp/vault"));
    expect(defaultVaultId("/tmp/vault")).not.toBe(defaultVaultId("/tmp/other"));
    expect(defaultVaultId("/tmp/vault")).toMatch(/^vault_[0-9a-f]{8}$/);
  });

  it("maps backend errors to non-sensitive UI categories", () => {
    expect(mapSyncError("sync transport error: network down")).toBe("offline");
    expect(mapSyncError("quota exceeded")).toBe("quotaExceeded");
    expect(mapSyncError("passphrase unwrap failed")).toBe("passphraseFailed");
    expect(mapSyncError("some unexpected path-specific failure")).toBe("unknown");
  });
});
