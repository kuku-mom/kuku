interface NoConfiguredVaultStatus {
  kind: "none";
  path: null;
  message: null;
}

interface MissingConfiguredVaultStatus {
  kind: "missing";
  path: string;
  message: string;
}

interface UnavailableConfiguredVaultStatus {
  kind: "unavailable";
  path: string;
  message: string;
}

type ConfiguredVaultStatus =
  | NoConfiguredVaultStatus
  | MissingConfiguredVaultStatus
  | UnavailableConfiguredVaultStatus;

const NO_CONFIGURED_VAULT_STATUS: NoConfiguredVaultStatus = {
  kind: "none",
  path: null,
  message: null,
};

function toVaultErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }
  return "Vault is unavailable.";
}

function isMissingVaultError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("must be an existing directory") ||
    normalized.includes("no such file or directory") ||
    normalized.includes("not found")
  );
}

function getConfiguredVaultStatus(
  configuredPath: string | null,
  error: unknown,
): ConfiguredVaultStatus | null {
  if (!configuredPath) {
    return NO_CONFIGURED_VAULT_STATUS;
  }

  if (!error) {
    return null;
  }

  const message = toVaultErrorMessage(error);
  return {
    kind: isMissingVaultError(message) ? "missing" : "unavailable",
    path: configuredPath,
    message,
  };
}

export { getConfiguredVaultStatus, NO_CONFIGURED_VAULT_STATUS };
export type { ConfiguredVaultStatus };
