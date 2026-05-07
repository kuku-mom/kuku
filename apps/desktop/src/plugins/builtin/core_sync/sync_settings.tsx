import { createEffect, createSignal, on, Show, type JSX } from "solid-js";

import {
  SettingsBanner,
  SettingsCard,
  SettingsFieldRow,
  SettingsInput,
  SettingsMetricRow,
  SettingsPanel,
  SettingsStatusBadge,
  SettingsToolbarAction,
} from "~/components/settings/settings_blocks";
import Switch from "~/components/ui/switch";
import { useSettingsRefreshToken } from "~/components/settings/settings_refresh";
import { t } from "~/i18n";
import { authState, getAuthService } from "~/plugins/builtin/core_auth/auth_service";
import { vaultState } from "~/stores/vault";

import { ConflictList } from "./conflict_list";
import { defaultVaultId, mapSyncError } from "./service";
import { refreshSyncStatus, syncStatus } from "./status_store";
import { getSyncService } from "./runtime";
import type { SyncPhase } from "./types";

function formatTimestamp(ts?: number): string {
  if (!ts) return t("settings.plugin.sync.metrics.never");
  return new Date(ts).toLocaleString();
}

function phaseLabel(phase: SyncPhase): string {
  switch (phase) {
    case "notConfigured":
      return t("settings.plugin.sync.phase.not_configured");
    case "disabled":
      return t("settings.plugin.sync.phase.disabled");
    case "planning":
      return t("settings.plugin.sync.phase.planning");
    case "packing":
      return t("settings.plugin.sync.phase.packing");
    case "transferring":
      return t("settings.plugin.sync.phase.transferring");
    case "publishing":
      return t("settings.plugin.sync.phase.publishing");
    case "applying":
      return t("settings.plugin.sync.phase.applying");
    case "error":
      return t("settings.plugin.sync.phase.error");
    default:
      return t("settings.plugin.sync.phase.idle");
  }
}

function phaseTone(phase: SyncPhase): "neutral" | "success" | "info" | "error" {
  if (phase === "error") return "error";
  if (phase === "disabled" || phase === "notConfigured") return "neutral";
  if (phase === "idle") return "success";
  return "info";
}

function errorCopy(error: string | undefined): string | null {
  if (!error) return null;
  switch (mapSyncError(error)) {
    case "authRequired":
      return t("settings.plugin.sync.error.auth_required");
    case "notConfigured":
      return t("settings.plugin.sync.error.not_configured");
    case "offline":
      return t("settings.plugin.sync.error.offline");
    case "passphraseFailed":
      return t("settings.plugin.sync.error.passphrase");
    case "quotaExceeded":
      return t("settings.plugin.sync.error.quota");
    default:
      return t("settings.plugin.sync.error.unknown");
  }
}

function SyncSettings(): JSX.Element {
  const settingsRefreshToken = useSettingsRefreshToken();
  const [remoteWorkspaceId, setRemoteWorkspaceId] = createSignal("");
  const [deviceId, setDeviceId] = createSignal("");
  const [passphrase, setPassphrase] = createSignal("");
  const [rememberWorkspaceKey, setRememberWorkspaceKey] = createSignal(true);
  const [busy, setBusy] = createSignal(false);
  const [localError, setLocalError] = createSignal<string | null>(null);
  const [confirmDisable, setConfirmDisable] = createSignal(false);
  const [authMode, setAuthMode] = createSignal<"ready" | "loginRequired" | "permissionRequired">(
    "ready",
  );

  async function refresh(options?: { reloadAuth?: boolean }): Promise<void> {
    const service = getSyncService();
    if (!service) return;
    setLocalError(null);
    await refreshSyncStatus(service);
    if (options?.reloadAuth) {
      setAuthMode(await service.authState());
    }
    if (syncStatus.remoteWorkspaceId && !remoteWorkspaceId()) {
      setRemoteWorkspaceId(syncStatus.remoteWorkspaceId);
    }
    if (syncStatus.deviceId && !deviceId()) {
      setDeviceId(syncStatus.deviceId);
    }
    setRememberWorkspaceKey(syncStatus.rememberWorkspaceKey);
  }

  createEffect(
    on(
      settingsRefreshToken,
      () => {
        void refresh({ reloadAuth: true });
      },
      { defer: false },
    ),
  );

  async function configure(): Promise<boolean> {
    const service = getSyncService();
    const rootPath = vaultState.rootPath;
    if (!service || !rootPath) {
      setLocalError(t("settings.plugin.sync.error.vault_required"));
      return false;
    }
    if (!syncStatus.configured && !passphrase().trim()) {
      setLocalError(t("settings.plugin.sync.error.passphrase_required"));
      return false;
    }

    const status = await service.configureVault({
      vaultId: syncStatus.vaultId ?? defaultVaultId(rootPath),
      rootPath,
      remoteWorkspaceId: remoteWorkspaceId().trim(),
      deviceId: deviceId().trim(),
      rememberWorkspaceKey: rememberWorkspaceKey(),
      passphrase: passphrase().trim() || undefined,
    });
    setLocalError(null);
    await refreshSyncStatus(service);
    return status.configured;
  }

  async function handleEnable(): Promise<void> {
    const service = getSyncService();
    if (!service || busy()) return;
    setBusy(true);
    try {
      const configured = syncStatus.configured || (await configure());
      if (!configured) return;
      await service.setEnabled(true);
      setPassphrase("");
      await refreshSyncStatus(service);
    } catch (error) {
      setLocalError(errorCopy(error instanceof Error ? error.message : String(error)));
    } finally {
      setBusy(false);
    }
  }

  async function handleDisable(): Promise<void> {
    const service = getSyncService();
    if (!service || busy()) return;
    if (!confirmDisable()) {
      setConfirmDisable(true);
      window.setTimeout(() => setConfirmDisable(false), 3000);
      return;
    }

    setBusy(true);
    try {
      await service.setEnabled(false);
      setConfirmDisable(false);
      await refreshSyncStatus(service);
    } catch (error) {
      setLocalError(errorCopy(error instanceof Error ? error.message : String(error)));
    } finally {
      setBusy(false);
    }
  }

  async function handleSyncNow(): Promise<void> {
    const service = getSyncService();
    if (!service || busy()) return;
    setBusy(true);
    try {
      await service.runOnce(passphrase().trim() || undefined);
      await refreshSyncStatus(service);
    } catch (error) {
      setLocalError(errorCopy(error instanceof Error ? error.message : String(error)));
    } finally {
      setBusy(false);
    }
  }

  const canSyncNow = () => syncStatus.configured && syncStatus.enabled && !busy();
  const visibleError = () => localError() ?? errorCopy(syncStatus.lastError);

  return (
    <SettingsPanel
      title={t("settings.plugin.sync.title")}
      description={t("settings.plugin.sync.description")}
      action={
        <SettingsToolbarAction disabled={busy()} onClick={() => void refresh({ reloadAuth: true })}>
          {t("settings.plugin.sync.action.refresh")}
        </SettingsToolbarAction>
      }
    >
      <Show when={!authState.authenticated || authMode() !== "ready"}>
        <SettingsBanner
          tone="warning"
          title={t("settings.plugin.sync.auth.title")}
          description={
            authMode() === "permissionRequired"
              ? t("settings.plugin.sync.auth.permission")
              : t("settings.plugin.sync.auth.login")
          }
          action={
            <SettingsToolbarAction
              variant="primary"
              disabled={authState.loading}
              onClick={() => void getAuthService()?.login()}
            >
              {authState.loading
                ? t("settings.plugin.account.action.opening")
                : t("settings.plugin.account.action.sign_in")}
            </SettingsToolbarAction>
          }
        />
      </Show>

      <Show when={!vaultState.rootPath}>
        <SettingsBanner tone="info" description={t("settings.plugin.sync.error.vault_required")} />
      </Show>

      <Show when={visibleError()}>
        {(message) => <SettingsBanner tone="error" description={message()} />}
      </Show>

      <SettingsCard
        title={t("settings.plugin.sync.status.title")}
        tone="subtle"
        action={
          <SettingsStatusBadge tone={phaseTone(syncStatus.phase)}>
            {phaseLabel(syncStatus.phase)}
          </SettingsStatusBadge>
        }
      >
        <div class="space-y-1.5">
          <SettingsMetricRow
            label={t("settings.plugin.sync.metrics.vault")}
            value={
              syncStatus.rootPath ?? vaultState.rootPath ?? t("settings.plugin.sync.metrics.none")
            }
            valueClass="max-w-80 truncate text-right"
          />
          <SettingsMetricRow
            label={t("settings.plugin.sync.metrics.workspace")}
            value={syncStatus.remoteWorkspaceId ?? t("settings.plugin.sync.metrics.none")}
            valueClass="max-w-80 truncate text-right"
          />
          <SettingsMetricRow
            label={t("settings.plugin.sync.metrics.device")}
            value={syncStatus.deviceId ?? t("settings.plugin.sync.metrics.none")}
            valueClass="max-w-80 truncate text-right"
          />
          <SettingsMetricRow
            label={t("settings.plugin.sync.metrics.last_synced")}
            value={formatTimestamp(syncStatus.lastSyncedAtMs)}
          />
          <SettingsMetricRow
            label={t("settings.plugin.sync.metrics.pending")}
            value={`${syncStatus.pendingUploads} / ${syncStatus.pendingDownloads}`}
          />
          <SettingsMetricRow
            label={t("settings.plugin.sync.metrics.conflicts")}
            value={String(syncStatus.conflictCount)}
          />
        </div>
      </SettingsCard>

      <SettingsCard title={t("settings.plugin.sync.configure.title")} tone="subtle">
        <div class="space-y-3">
          <SettingsFieldRow
            label={t("settings.plugin.sync.workspace.label")}
            description={t("settings.plugin.sync.workspace.description")}
            control={
              <SettingsInput
                value={remoteWorkspaceId()}
                onInput={(event) => setRemoteWorkspaceId(event.currentTarget.value)}
                placeholder={t("settings.plugin.sync.workspace.placeholder")}
              />
            }
            stacked
          />
          <SettingsFieldRow
            label={t("settings.plugin.sync.device.label")}
            description={t("settings.plugin.sync.device.description")}
            control={
              <SettingsInput
                value={deviceId()}
                onInput={(event) => setDeviceId(event.currentTarget.value)}
              />
            }
            stacked
          />
          <SettingsFieldRow
            label={t("settings.plugin.sync.passphrase.label")}
            description={t("settings.plugin.sync.passphrase.description")}
            control={
              <SettingsInput
                type="password"
                value={passphrase()}
                onInput={(event) => setPassphrase(event.currentTarget.value)}
                placeholder={t("settings.plugin.sync.passphrase.placeholder")}
              />
            }
            stacked
          />
          <SettingsFieldRow
            label={t("settings.plugin.sync.remember.label")}
            description={t("settings.plugin.sync.remember.description")}
            control={<Switch checked={rememberWorkspaceKey()} onChange={setRememberWorkspaceKey} />}
          />
        </div>
      </SettingsCard>

      <SettingsCard
        tone={syncStatus.enabled ? "muted" : "subtle"}
        description={
          syncStatus.enabled
            ? t("settings.plugin.sync.enable.enabled_description")
            : t("settings.plugin.sync.enable.disabled_description")
        }
        action={
          <div class="flex flex-wrap justify-end gap-2">
            <SettingsToolbarAction
              variant="primary"
              disabled={!canSyncNow()}
              onClick={() => void handleSyncNow()}
            >
              {busy()
                ? t("settings.plugin.sync.action.working")
                : t("settings.plugin.sync.action.sync_now")}
            </SettingsToolbarAction>
            <Show
              when={syncStatus.enabled}
              fallback={
                <SettingsToolbarAction
                  variant="primary"
                  disabled={busy()}
                  onClick={() => void handleEnable()}
                >
                  {busy()
                    ? t("settings.plugin.sync.action.working")
                    : t("settings.plugin.sync.action.enable")}
                </SettingsToolbarAction>
              }
            >
              <SettingsToolbarAction
                variant={confirmDisable() ? "destructive" : "warning"}
                disabled={busy()}
                onClick={() => void handleDisable()}
              >
                {confirmDisable()
                  ? t("settings.plugin.sync.action.confirm_disable")
                  : t("settings.plugin.sync.action.disable")}
              </SettingsToolbarAction>
            </Show>
          </div>
        }
      >
        <div class="text-[0.6875rem] text-text-muted">{t("settings.plugin.sync.enable.help")}</div>
      </SettingsCard>

      <SettingsCard
        title={t("settings.plugin.sync.conflicts.title")}
        description={t("settings.plugin.sync.conflicts.description")}
        tone="subtle"
      >
        <ConflictList />
      </SettingsCard>
    </SettingsPanel>
  );
}

export { SyncSettings };
