type VaultSidebarFooterActionId = "switch-vault" | "settings";

function getVaultSidebarFooterActionIds(params: {
  hasOpenVault: boolean;
}): VaultSidebarFooterActionId[] {
  if (!params.hasOpenVault) return [];
  return ["switch-vault", "settings"];
}

function getVaultSidebarFooterVaultLabel(params: { rootName: string | null }): string | null {
  return params.rootName?.trim() || null;
}

export { getVaultSidebarFooterActionIds, getVaultSidebarFooterVaultLabel };
export type { VaultSidebarFooterActionId };
