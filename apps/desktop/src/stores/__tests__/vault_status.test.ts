import { describe, expect, it } from "vitest";

import { getConfiguredVaultStatus, NO_CONFIGURED_VAULT_STATUS } from "~/stores/vault_status";

describe("configured vault status", () => {
  it("returns the empty-state status when no vault is configured", () => {
    expect(getConfiguredVaultStatus(null, null)).toEqual(NO_CONFIGURED_VAULT_STATUS);
  });

  it("marks restore failures for missing vaults with the saved path", () => {
    const status = getConfiguredVaultStatus(
      "/Users/mansuiki/vault",
      new Error("Vault path must be an existing directory: No such file or directory"),
    );

    expect(status).toEqual({
      kind: "missing",
      path: "/Users/mansuiki/vault",
      message: "Vault path must be an existing directory: No such file or directory",
    });
  });

  it("clears prior errors once the vault opens successfully", () => {
    expect(getConfiguredVaultStatus("/Users/mansuiki/vault", null)).toBeNull();
  });

  it("resets to the unconfigured state when the configured vault is cleared", () => {
    const status = getConfiguredVaultStatus(null, new Error("Permission denied"));

    expect(status).toEqual(NO_CONFIGURED_VAULT_STATUS);
  });
});
