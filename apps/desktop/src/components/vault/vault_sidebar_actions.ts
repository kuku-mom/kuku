type VaultSidebarFooterActionId = "switch-vault" | "settings";

function getVaultSidebarFooterActionIds(params: {
  hasOpenVault: boolean;
}): VaultSidebarFooterActionId[] {
  if (!params.hasOpenVault) return [];
  return ["switch-vault", "settings"];
}

export { getVaultSidebarFooterActionIds };
export type { VaultSidebarFooterActionId };
