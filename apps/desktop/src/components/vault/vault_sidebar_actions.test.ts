import { describe, expect, it } from "vitest";

import {
  getVaultSidebarFooterActionIds,
  getVaultSidebarFooterVaultLabel,
} from "./vault_sidebar_actions";

describe("vault sidebar actions", () => {
  it("places vault switching and settings in the left sidebar footer when a vault is open", () => {
    expect(getVaultSidebarFooterActionIds({ hasOpenVault: true })).toEqual([
      "switch-vault",
      "settings",
    ]);
  });

  it("does not duplicate vault footer actions in the empty vault state", () => {
    expect(getVaultSidebarFooterActionIds({ hasOpenVault: false })).toEqual([]);
  });

  it("uses the current vault name as the footer label", () => {
    expect(getVaultSidebarFooterVaultLabel({ rootName: "Axpace" })).toBe("Axpace");
  });

  it("does not show a footer label when no vault is open", () => {
    expect(getVaultSidebarFooterVaultLabel({ rootName: null })).toBeNull();
  });
});
