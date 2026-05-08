import { invoke } from "@tauri-apps/api/core";

import type { AuthService } from "../core_auth";
import type {
  SyncAccountRecoveryState,
  SyncAuthState,
  SyncCommandError,
  SyncConflictSummary,
  SyncCreateWorkspaceInput,
  SyncErrorCategory,
  SyncRenameWorkspaceInput,
  SyncRemoteStatus,
  SyncRuntimeStatus,
  SyncVaultConfig,
  SyncWorkspaceSummary,
} from "./types";

const CORE_SYNC_PLUGIN_ID = "core-sync";

interface SyncStatusOptions {
  scanLocal?: boolean;
}

interface SyncService {
  getStatus(options?: SyncStatusOptions): Promise<SyncRuntimeStatus>;
  getRemoteStatus(): Promise<SyncRemoteStatus>;
  getCachedRemoteStatus(): Promise<SyncRemoteStatus | null>;
  getSavedPassphrase(vaultId: string): Promise<string | null>;
  generateRecoveryPhrase(): Promise<string>;
  getSavedRecoveryPhrase(accountKeyId: string): Promise<string | null>;
  getAccountRecoveryState(): Promise<SyncAccountRecoveryState>;
  listWorkspaces(passphrase?: string): Promise<SyncWorkspaceSummary[]>;
  createWorkspace(input: SyncCreateWorkspaceInput): Promise<SyncWorkspaceSummary>;
  renameWorkspace(input: SyncRenameWorkspaceInput): Promise<SyncWorkspaceSummary>;
  deleteWorkspace(workspaceId: string): Promise<SyncRuntimeStatus>;
  saveRecoveryPhraseFile(phrase: string): Promise<boolean>;
  configureVault(config: SyncVaultConfig): Promise<SyncRuntimeStatus>;
  disconnectVault(): Promise<SyncRuntimeStatus>;
  rebuildVaultState(): Promise<SyncRuntimeStatus>;
  setEnabled(enabled: boolean): Promise<SyncRuntimeStatus>;
  runOnce(passphrase?: string): Promise<SyncRuntimeStatus>;
  listConflicts(): Promise<SyncConflictSummary[]>;
  authState(): Promise<SyncAuthState>;
}

function createSyncService(authService?: AuthService | null): SyncService {
  async function authState(): Promise<SyncAuthState> {
    if (!authService) return "ready";
    const result = await authService.requestAuthorization(CORE_SYNC_PLUGIN_ID);
    if (result.status === "permissionRequired") return "permissionRequired";
    if (result.status === "loginRequired") return "loginRequired";
    return "ready";
  }

  return {
    async getStatus(options) {
      return invoke<SyncRuntimeStatus>("sync_get_status", {
        scanLocal: options?.scanLocal ?? false,
      });
    },
    async getRemoteStatus() {
      return invoke<SyncRemoteStatus>("sync_get_remote_status");
    },
    async getCachedRemoteStatus() {
      return invoke<SyncRemoteStatus | null>("sync_get_cached_remote_status");
    },
    async getSavedPassphrase(vaultId) {
      return invoke<string | null>("sync_get_saved_passphrase", { vaultId });
    },
    async generateRecoveryPhrase() {
      return invoke<string>("sync_generate_recovery_phrase");
    },
    async getSavedRecoveryPhrase(accountKeyId) {
      return invoke<string | null>("sync_get_saved_recovery_phrase", { accountKeyId });
    },
    async getAccountRecoveryState() {
      return invoke<SyncAccountRecoveryState>("sync_get_account_recovery_state");
    },
    async listWorkspaces(passphrase) {
      return invoke<SyncWorkspaceSummary[]>("sync_list_workspaces", { passphrase });
    },
    async createWorkspace(input) {
      return invoke<SyncWorkspaceSummary>("sync_create_workspace", { request: input });
    },
    async renameWorkspace(input) {
      return invoke<SyncWorkspaceSummary>("sync_rename_workspace", { request: input });
    },
    async deleteWorkspace(workspaceId) {
      return invoke<SyncRuntimeStatus>("sync_delete_workspace", { workspaceId });
    },
    async saveRecoveryPhraseFile(phrase) {
      return invoke<boolean>("sync_save_recovery_phrase_file", { phrase });
    },
    async configureVault(config) {
      return invoke<SyncRuntimeStatus>("sync_configure_vault", { config });
    },
    async disconnectVault() {
      return invoke<SyncRuntimeStatus>("sync_disconnect_vault");
    },
    async rebuildVaultState() {
      return invoke<SyncRuntimeStatus>("sync_rebuild_vault_state");
    },
    async setEnabled(enabled) {
      return invoke<SyncRuntimeStatus>("sync_set_enabled", { enabled });
    },
    async runOnce(passphrase) {
      return invoke<SyncRuntimeStatus>("sync_run_once", { passphrase });
    },
    async listConflicts() {
      return invoke<SyncConflictSummary[]>("sync_list_conflicts");
    },
    authState,
  };
}

function defaultVaultId(rootPath: string): string {
  const hash = fnv1a32(rootPath.trim()).toString(16).padStart(8, "0");
  return `vault_${hash}`;
}

function defaultDeviceId(): string {
  const stored = window.localStorage.getItem("kuku.sync.deviceId");
  if (stored) return stored;
  const random = crypto.getRandomValues(new Uint8Array(8));
  const id = `device_${Array.from(random, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  window.localStorage.setItem("kuku.sync.deviceId", id);
  return id;
}

function mapSyncError(error: unknown): SyncErrorCategory {
  const typed = parseSyncCommandError(error);
  if (typed) return typed.category;
  const message = syncErrorMessage(error);
  const lower = message.toLowerCase();
  if (lower.includes("not configured")) return "notConfigured";
  if (lower.includes("sync disabled")) return "syncDisabled";
  if (lower.includes("quota")) return "quotaExceeded";
  if (
    lower.includes("permission_denied") ||
    lower.includes("permission denied") ||
    lower.includes("permission required") ||
    lower.includes("permission is required")
  ) {
    return "permissionRequired";
  }
  if (lower.includes("network") || lower.includes("offline") || lower.includes("transport")) {
    return "offline";
  }
  if (lower.includes("passphrase") || lower.includes("crypto")) return "passphraseFailed";
  if (
    lower.includes("auth") ||
    lower.includes("login") ||
    lower.includes("unauthenticated") ||
    lower.includes("unauthorized")
  ) {
    return "loginRequired";
  }
  if (lower.includes("server") || lower.includes("internal")) return "server";
  return "unknown";
}

function parseSyncCommandError(error: unknown): SyncCommandError | null {
  if (isSyncCommandError(error)) return error;
  if (error instanceof Error) {
    return parseSyncCommandErrorString(error.message);
  }
  if (typeof error === "string") {
    return parseSyncCommandErrorString(error);
  }
  return null;
}

function parseSyncCommandErrorString(value: string): SyncCommandError | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isSyncCommandError(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isSyncCommandError(value: unknown): value is SyncCommandError {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { category?: unknown; message?: unknown };
  return isSyncErrorCategory(candidate.category) && typeof candidate.message === "string";
}

function isSyncErrorCategory(value: unknown): value is SyncErrorCategory {
  return (
    value === "notConfigured" ||
    value === "loginRequired" ||
    value === "permissionRequired" ||
    value === "syncDisabled" ||
    value === "offline" ||
    value === "quotaExceeded" ||
    value === "passphraseFailed" ||
    value === "server" ||
    value === "unknown"
  );
}

function syncErrorMessage(error: unknown): string {
  const typed = parseSyncCommandError(error);
  if (typed) return typed.message;
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}

function fnv1a32(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export {
  CORE_SYNC_PLUGIN_ID,
  createSyncService,
  defaultDeviceId,
  defaultVaultId,
  mapSyncError,
  parseSyncCommandError,
};
export type { SyncService, SyncStatusOptions };
