import { invoke } from "@tauri-apps/api/core";

import type { AuthService } from "../core_auth";
import type {
  SyncAuthState,
  SyncConflictSummary,
  SyncRuntimeStatus,
  SyncVaultConfig,
} from "./types";

const CORE_SYNC_PLUGIN_ID = "core-sync";

interface SyncService {
  getStatus(): Promise<SyncRuntimeStatus>;
  configureVault(config: SyncVaultConfig): Promise<SyncRuntimeStatus>;
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
    async getStatus() {
      return invoke<SyncRuntimeStatus>("sync_get_status");
    },
    async configureVault(config) {
      return invoke<SyncRuntimeStatus>("sync_configure_vault", { config });
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

function mapSyncError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (lower.includes("not configured")) return "notConfigured";
  if (lower.includes("quota")) return "quotaExceeded";
  if (lower.includes("network") || lower.includes("offline") || lower.includes("transport")) {
    return "offline";
  }
  if (lower.includes("passphrase") || lower.includes("crypto")) return "passphraseFailed";
  if (lower.includes("auth") || lower.includes("login") || lower.includes("unauthorized")) {
    return "authRequired";
  }
  return "unknown";
}

function fnv1a32(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export { CORE_SYNC_PLUGIN_ID, createSyncService, defaultDeviceId, defaultVaultId, mapSyncError };
export type { SyncService };
