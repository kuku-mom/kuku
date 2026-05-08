import { createEffect, createMemo, createSignal, For, on, Show, type JSX } from "solid-js";

import {
  SettingsBanner,
  SettingsCard,
  SettingsInput,
  SettingsListRow,
  SettingsMetricRow,
  SettingsPanel,
  SettingsStatusBadge,
  SettingsToolbarAction,
} from "~/components/settings/settings_blocks";
import { useSettingsRefreshToken } from "~/components/settings/settings_refresh";
import { t } from "~/i18n";
import { authState, getAuthService } from "~/plugins/builtin/core_auth/auth_service";
import { vaultState } from "~/stores/vault";

import { ConflictList } from "./conflict_list";
import { defaultVaultId, mapSyncError, parseSyncCommandError, type SyncService } from "./service";
import {
  applySyncRemoteStatus,
  applySyncStatus,
  refreshSyncStatus,
  syncStatus,
} from "./status_store";
import { getSyncService } from "./runtime";
import { transferStatusLabel } from "./transfer_status";
import type {
  SyncAccountRecoveryState,
  SyncErrorCategory,
  SyncRuntimeStatus,
  SyncWorkspaceSummary,
} from "./types";

function formatTimestamp(ts?: number): string {
  if (!ts) return t("settings.plugin.sync.metrics.never");
  return new Date(ts).toLocaleString();
}

function hasPendingWork(status: SyncRuntimeStatus): boolean {
  return status.pendingUploads > 0 || status.pendingDownloads > 0;
}

function basename(path?: string | null): string {
  const trimmed = path?.trim();
  if (!trimmed) return "";
  const parts = trimmed.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) ?? trimmed;
}

function phaseLabel(status: SyncRuntimeStatus): string {
  if (status.phase === "idle" && hasPendingWork(status)) {
    return t("sync.indicator.pending");
  }

  const phase = status.phase;
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

function phaseTone(status: SyncRuntimeStatus): "neutral" | "success" | "info" | "error" {
  const phase = status.phase;
  if (phase === "error") return "error";
  if (phase === "disabled" || phase === "notConfigured") return "neutral";
  if (phase === "idle" && hasPendingWork(status)) return "neutral";
  if (phase === "idle") return "success";
  return "info";
}

function errorCopy(error: unknown, category?: SyncErrorCategory): string | null {
  if (!error && !category) return null;
  const detail = errorDetail(error);
  switch (category ?? mapSyncError(error)) {
    case "loginRequired":
      return t("settings.plugin.sync.error.auth_required");
    case "permissionRequired":
      return t("settings.plugin.sync.error.permission_required");
    case "syncDisabled":
      return t("settings.plugin.sync.error.sync_disabled");
    case "notConfigured":
      return t("settings.plugin.sync.error.not_configured");
    case "offline":
      return t("settings.plugin.sync.error.offline");
    case "passphraseFailed":
      return t("settings.plugin.sync.error.passphrase");
    case "quotaExceeded":
      return detail ?? t("settings.plugin.sync.error.quota");
    case "server":
      return t("settings.plugin.sync.error.server");
    default:
      return t("settings.plugin.sync.error.unknown");
  }
}

function errorDetail(error: unknown): string | null {
  const typed = parseSyncCommandError(error);
  if (typed?.message.trim()) return typed.message;
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return null;
}

function SyncSettings(): JSX.Element {
  const settingsRefreshToken = useSettingsRefreshToken();
  const [recoveryPhrase, setRecoveryPhrase] = createSignal("");
  const [recoveryPhraseSource, setRecoveryPhraseSource] = createSignal<
    "empty" | "generated" | "saved" | "user"
  >("empty");
  const [showRecoveryPhrase, setShowRecoveryPhrase] = createSignal(false);
  const [recoveryPhraseExpanded, setRecoveryPhraseExpanded] = createSignal(true);
  const [recoveryPhraseCopied, setRecoveryPhraseCopied] = createSignal(false);
  const [recoveryPhraseSaving, setRecoveryPhraseSaving] = createSignal(false);
  const [recoveryPhraseBackedUp, setRecoveryPhraseBackedUp] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [workspaceLoading, setWorkspaceLoading] = createSignal(false);
  const [workspaceBusyId, setWorkspaceBusyId] = createSignal<string | null>(null);
  const [workspaces, setWorkspaces] = createSignal<SyncWorkspaceSummary[]>([]);
  const [renamingWorkspaceId, setRenamingWorkspaceId] = createSignal<string | null>(null);
  const [workspaceDraftName, setWorkspaceDraftName] = createSignal("");
  const [confirmDeleteWorkspaceId, setConfirmDeleteWorkspaceId] = createSignal<string | null>(null);
  const [localError, setLocalError] = createSignal<string | null>(null);
  const [accountRecoveryState, setAccountRecoveryState] =
    createSignal<SyncAccountRecoveryState | null>(null);
  const [confirmDisable, setConfirmDisable] = createSignal(false);
  const [authMode, setAuthMode] = createSignal<"ready" | "loginRequired" | "permissionRequired">(
    "ready",
  );

  const authReady = () => authState.authenticated && authMode() === "ready";
  const settingsDisabled = () => !authReady();
  const activeAccountKeyId = () => syncStatus.accountKeyId ?? accountRecoveryState()?.accountKeyId;
  const accountRecoveryConfigured = () => Boolean(activeAccountKeyId());
  const accountRecoveryApplied = () => accountRecoveryState()?.applied ?? false;
  const canCreateAccountRecovery = () =>
    !syncStatus.configured && accountRecoveryState()?.configured === false;
  const requiresAccountUnlock = () => {
    const state = accountRecoveryState();
    return Boolean(state?.configured && state.recoveryPhraseConfigured && !state.applied);
  };
  const recoveryPhraseUnavailable = () => {
    const state = accountRecoveryState();
    return Boolean(state?.configured && !state.recoveryPhraseConfigured && !state.applied);
  };

  async function refreshAccountRecoveryState(
    service: SyncService,
  ): Promise<SyncAccountRecoveryState | null> {
    if (!authReady()) {
      setAccountRecoveryState(null);
      return null;
    }

    const state = await service.getAccountRecoveryState().catch(() => null);
    setAccountRecoveryState(state);
    return state;
  }

  async function refresh(options?: { reloadAuth?: boolean }): Promise<void> {
    const service = getSyncService();
    if (!service) return;
    setLocalError(null);
    await refreshSyncStatus(service, { scanLocal: true });
    if (options?.reloadAuth) {
      setAuthMode(await service.authState());
    }
    const accountRecovery = await refreshAccountRecoveryState(service);
    const accountKeyId = syncStatus.accountKeyId ?? accountRecovery?.accountKeyId;
    if (accountKeyId && !recoveryPhrase()) {
      const savedRecoveryPhrase = await service
        .getSavedRecoveryPhrase(accountKeyId)
        .catch(() => null);
      if (savedRecoveryPhrase) {
        setRecoveryPhrase(savedRecoveryPhrase);
        setRecoveryPhraseSource("saved");
        if (accountRecovery?.applied) {
          setRecoveryPhraseExpanded(false);
        }
      }
    }
    if (accountRecovery?.configured && recoveryPhraseSource() === "generated") {
      setRecoveryPhrase("");
      setRecoveryPhraseSource("empty");
      setRecoveryPhraseBackedUp(false);
      setRecoveryPhraseExpanded(true);
    }
    if (canCreateAccountRecovery() && !recoveryPhrase()) {
      const generated = await service.generateRecoveryPhrase().catch(() => null);
      if (generated) {
        setRecoveryPhrase(generated);
        setRecoveryPhraseSource("generated");
        setRecoveryPhraseExpanded(true);
      }
    }
    if (accountRecovery?.configured && !accountRecovery.applied) {
      setRecoveryPhraseExpanded(true);
      setWorkspaces([]);
    } else if (syncStatus.configured || accountKeyId) {
      await loadWorkspaces({ quiet: true });
    } else {
      setWorkspaces([]);
    }
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

  createEffect(
    on(
      () => [authState.authenticated, authState.loading] as const,
      ([authenticated, loading]) => {
        if (loading) return;
        if (!authenticated) {
          setAuthMode("loginRequired");
          setAccountRecoveryState(null);
          setRecoveryPhraseExpanded(true);
          setWorkspaces([]);
          return;
        }
        void refresh({ reloadAuth: true });
      },
      { defer: true },
    ),
  );

  async function handleCreateWorkspace(): Promise<void> {
    const service = getSyncService();
    if (!service || busy()) return;
    if (settingsDisabled()) {
      setLocalError(t("settings.plugin.sync.error.auth_required"));
      return;
    }
    setBusy(true);
    try {
      if (requiresAccountUnlock()) {
        setLocalError(t("settings.plugin.sync.passphrase.unlock_required"));
        return;
      }
      if (recoveryPhraseUnavailable()) {
        setLocalError(t("settings.plugin.sync.passphrase.reset_only"));
        return;
      }
      if (requiresRecoveryBackup() && !recoveryPhraseBackedUp()) {
        setLocalError(t("settings.plugin.sync.error.recovery_backup_required"));
        return;
      }
      await service.createWorkspace({
        passphrase: recoveryPhrase().trim() || undefined,
      });
      setLocalError(null);
      await refreshAccountRecoveryState(service);
      await loadWorkspaces({ quiet: true });
    } catch (error) {
      setLocalError(errorCopy(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleDisable(): Promise<void> {
    const service = getSyncService();
    if (!service || busy() || settingsDisabled()) return;
    if (!confirmDisable()) {
      setConfirmDisable(true);
      window.setTimeout(() => setConfirmDisable(false), 3000);
      return;
    }

    setBusy(true);
    try {
      await service.disconnectVault();
      setConfirmDisable(false);
      setLocalError(null);
      await refreshSyncStatus(service, { scanLocal: true });
      await loadWorkspaces({ quiet: true });
    } catch (error) {
      setLocalError(errorCopy(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleSyncNow(): Promise<void> {
    const service = getSyncService();
    if (!service || busy() || settingsDisabled()) return;
    setBusy(true);
    try {
      await service.runOnce(recoveryPhrase().trim() || undefined);
      setLocalError(null);
      await refreshSyncStatus(service, { scanLocal: true });
    } catch (error) {
      setLocalError(errorCopy(error));
    } finally {
      setBusy(false);
    }
  }

  async function refreshWorkspaceAndRemoteStatus(): Promise<void> {
    const service = getSyncService();
    if (!service || workspaceActionBusy()) return;
    const refreshRemote = async () => {
      const refreshed = await refreshSyncStatus(service, { scanLocal: true });
      if (!refreshed || !syncStatus.configured || !syncStatus.enabled) return;
      const remoteStatus = await service.getRemoteStatus();
      if (syncStatus.remoteWorkspaceId === remoteStatus.workspaceId) {
        applySyncRemoteStatus(remoteStatus);
      }
    };

    try {
      await Promise.all([loadWorkspaces(), refreshRemote()]);
    } catch (error) {
      setLocalError(errorCopy(error));
    }
  }

  async function handleRebuildSyncState(): Promise<void> {
    const service = getSyncService();
    if (!service || busy() || settingsDisabled()) return;
    setBusy(true);
    try {
      applySyncStatus(await service.rebuildVaultState());
      setLocalError(null);
      await refreshSyncStatus(service, { scanLocal: true });
      await refreshWorkspaceAndRemoteStatus();
    } catch (error) {
      setLocalError(errorCopy(error));
    } finally {
      setBusy(false);
    }
  }

  const canSyncNow = () => authReady() && syncStatus.configured && syncStatus.enabled && !busy();
  const canRebuildSyncState = () => authReady() && syncStatus.configured && !busy();
  const workspaceActionBusy = () =>
    settingsDisabled() || workspaceLoading() || workspaceBusyId() !== null;
  const disabledCardClass = () => (settingsDisabled() ? "opacity-60" : undefined);
  const visibleError = () =>
    localError() ?? errorCopy(syncStatus.lastError, syncStatus.lastErrorCategory);
  const recoveryPhraseWords = createMemo(() =>
    recoveryPhrase().trim().split(/\s+/).filter(Boolean),
  );
  const requiresRecoveryBackup = () => canCreateAccountRecovery();
  const recoveryPhraseCollapsed = () =>
    !recoveryPhraseExpanded() &&
    accountRecoveryApplied() &&
    !requiresAccountUnlock() &&
    !requiresRecoveryBackup();
  const recoveryPhraseDescription = () => {
    if (recoveryPhraseCollapsed()) return t("settings.plugin.sync.passphrase.verified");
    if (accountRecoveryConfigured()) return t("settings.plugin.sync.passphrase.description");
    return t("settings.plugin.sync.passphrase.create_description");
  };
  const currentWorkspaceSyncActionVariant = (): "primary" | "warning" | "destructive" =>
    confirmDisable() ? "destructive" : "warning";
  const currentWorkspaceSyncActionLabel = () => {
    if (busy()) return t("settings.plugin.sync.action.working");
    return confirmDisable()
      ? t("settings.plugin.sync.action.confirm_disable")
      : t("settings.plugin.sync.action.disable");
  };

  async function generateRecoveryPhrase(): Promise<void> {
    const service = getSyncService();
    if (!service || busy() || settingsDisabled()) return;
    if (!canCreateAccountRecovery()) return;
    setBusy(true);
    try {
      const generated = await service.generateRecoveryPhrase();
      setRecoveryPhrase(generated);
      setRecoveryPhraseSource("generated");
      setShowRecoveryPhrase(true);
      setRecoveryPhraseBackedUp(false);
      setLocalError(null);
    } catch (error) {
      setLocalError(errorCopy(error));
    } finally {
      setBusy(false);
    }
  }

  async function copyRecoveryPhrase(): Promise<void> {
    if (settingsDisabled()) return;
    const phrase = recoveryPhrase().trim();
    if (!phrase) return;
    try {
      await navigator.clipboard.writeText(phrase);
      setRecoveryPhraseCopied(true);
      window.setTimeout(() => setRecoveryPhraseCopied(false), 1500);
    } catch {
      setLocalError(t("settings.plugin.sync.error.unknown"));
    }
  }

  async function saveRecoveryPhrase(): Promise<void> {
    const service = getSyncService();
    const phrase = recoveryPhrase().trim();
    if (!service || !phrase || recoveryPhraseSaving() || settingsDisabled()) return;
    setRecoveryPhraseSaving(true);
    try {
      const saved = await service.saveRecoveryPhraseFile(phrase);
      if (saved) {
        setRecoveryPhraseBackedUp(true);
      }
    } catch (error) {
      setLocalError(errorCopy(error));
    } finally {
      setRecoveryPhraseSaving(false);
    }
  }

  async function verifyRecoveryPhrase(): Promise<void> {
    const service = getSyncService();
    const phrase = recoveryPhrase().trim();
    if (!service || busy() || workspaceLoading() || settingsDisabled()) return;
    if (!phrase) {
      setLocalError(t("settings.plugin.sync.error.passphrase_required"));
      return;
    }
    setWorkspaceLoading(true);
    try {
      const rows = await service.listWorkspaces(phrase);
      setWorkspaces(rows);
      await refreshAccountRecoveryState(service);
      setLocalError(null);
      setShowRecoveryPhrase(false);
      setRecoveryPhraseExpanded(false);
    } catch (error) {
      setWorkspaces([]);
      setLocalError(errorCopy(error));
    } finally {
      setWorkspaceLoading(false);
    }
  }

  async function loadWorkspaces(options?: { quiet?: boolean }): Promise<void> {
    const service = getSyncService();
    if (!service || workspaceLoading()) return;
    if (!authReady()) {
      setWorkspaces([]);
      return;
    }
    if (requiresAccountUnlock() && !recoveryPhrase().trim()) {
      setWorkspaces([]);
      if (!options?.quiet) setLocalError(t("settings.plugin.sync.error.passphrase_required"));
      return;
    }
    if (options?.quiet && requiresAccountUnlock()) {
      setWorkspaces([]);
      return;
    }
    setWorkspaceLoading(true);
    try {
      const rows = await service.listWorkspaces(recoveryPhrase().trim() || undefined);
      setWorkspaces(rows);
      if (!options?.quiet) setLocalError(null);
    } catch (error) {
      if (!options?.quiet) setLocalError(errorCopy(error));
    } finally {
      setWorkspaceLoading(false);
    }
  }

  async function connectWorkspace(workspace: SyncWorkspaceSummary): Promise<void> {
    const service = getSyncService();
    const rootPath = vaultState.rootPath;
    if (!service || workspaceActionBusy()) return;
    if (!rootPath) {
      setLocalError(t("settings.plugin.sync.error.vault_required"));
      return;
    }
    setWorkspaceBusyId(workspace.workspaceId);
    try {
      await service.configureVault({
        vaultId: syncStatus.vaultId ?? defaultVaultId(rootPath),
        rootPath,
        accountKeyId: activeAccountKeyId(),
        remoteWorkspaceId: workspace.workspaceId,
        workspaceName: workspace.name,
        deviceId: syncStatus.deviceId ?? "",
        deviceName: syncStatus.deviceName,
        rememberWorkspaceKey: true,
        passphrase: recoveryPhrase().trim() || undefined,
      });
      await service.setEnabled(true);
      setLocalError(null);
      await refreshSyncStatus(service, { scanLocal: true });
      await loadWorkspaces({ quiet: true });
    } catch (error) {
      setLocalError(errorCopy(error));
    } finally {
      setWorkspaceBusyId(null);
    }
  }

  function startRenameWorkspace(workspace: SyncWorkspaceSummary): void {
    setRenamingWorkspaceId(workspace.workspaceId);
    setWorkspaceDraftName(workspace.name);
    setConfirmDeleteWorkspaceId(null);
  }

  async function saveWorkspaceRename(workspace: SyncWorkspaceSummary): Promise<void> {
    const service = getSyncService();
    const name = workspaceDraftName().trim();
    if (!service || workspaceActionBusy()) return;
    if (!name) {
      setLocalError(t("settings.plugin.sync.error.workspace_name_required"));
      return;
    }
    setWorkspaceBusyId(workspace.workspaceId);
    try {
      const updated = await service.renameWorkspace({
        workspaceId: workspace.workspaceId,
        name,
        expectedMetadataVersion: workspace.metadataVersion,
        passphrase: recoveryPhrase().trim() || undefined,
      });
      setWorkspaces((rows) =>
        rows.map((row) => (row.workspaceId === updated.workspaceId ? updated : row)),
      );
      setRenamingWorkspaceId(null);
      setWorkspaceDraftName("");
      setLocalError(null);
      if (updated.current) {
        await refreshSyncStatus(service, { scanLocal: true });
      }
    } catch (error) {
      setLocalError(errorCopy(error));
    } finally {
      setWorkspaceBusyId(null);
    }
  }

  async function deleteWorkspace(workspace: SyncWorkspaceSummary): Promise<void> {
    const service = getSyncService();
    if (!service || workspaceActionBusy()) return;
    if (confirmDeleteWorkspaceId() !== workspace.workspaceId) {
      setConfirmDeleteWorkspaceId(workspace.workspaceId);
      window.setTimeout(() => {
        if (confirmDeleteWorkspaceId() === workspace.workspaceId) {
          setConfirmDeleteWorkspaceId(null);
        }
      }, 3000);
      return;
    }
    setWorkspaceBusyId(workspace.workspaceId);
    try {
      const status = await service.deleteWorkspace(workspace.workspaceId);
      applySyncStatus(status);
      setWorkspaces((rows) => rows.filter((row) => row.workspaceId !== workspace.workspaceId));
      setConfirmDeleteWorkspaceId(null);
      setLocalError(null);
      await refreshSyncStatus(service, { scanLocal: true });
      await refreshAccountRecoveryState(service);
      await loadWorkspaces({ quiet: true });
    } catch (error) {
      setLocalError(errorCopy(error));
    } finally {
      setWorkspaceBusyId(null);
    }
  }

  return (
    <SettingsPanel
      title={t("settings.plugin.sync.title")}
      description={t("settings.plugin.sync.description")}
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
        title={t("settings.plugin.sync.passphrase.label")}
        description={recoveryPhraseDescription()}
        tone="subtle"
        class={disabledCardClass()}
        bodyClass={recoveryPhraseCollapsed() ? "hidden" : undefined}
        action={
          <Show
            when={accountRecoveryApplied() && recoveryPhrase().trim() && !requiresRecoveryBackup()}
          >
            <SettingsToolbarAction
              disabled={settingsDisabled()}
              onClick={() => {
                setRecoveryPhraseExpanded((expanded) => !expanded);
                setShowRecoveryPhrase(false);
              }}
            >
              {recoveryPhraseExpanded()
                ? t("settings.plugin.sync.passphrase.collapse")
                : t("settings.plugin.sync.passphrase.edit")}
            </SettingsToolbarAction>
          </Show>
        }
      >
        <div class="space-y-2">
          <Show when={requiresAccountUnlock()}>
            <SettingsBanner
              tone="warning"
              description={t("settings.plugin.sync.passphrase.unlock_description")}
            />
          </Show>
          <Show when={recoveryPhraseUnavailable()}>
            <SettingsBanner
              tone="error"
              description={t("settings.plugin.sync.passphrase.reset_only")}
            />
          </Show>
          <div class="flex flex-wrap gap-2">
            <Show when={canCreateAccountRecovery()}>
              <SettingsToolbarAction
                disabled={settingsDisabled() || busy()}
                onClick={() => void generateRecoveryPhrase()}
              >
                {t("settings.plugin.sync.passphrase.generate")}
              </SettingsToolbarAction>
            </Show>
            <Show when={requiresAccountUnlock()}>
              <SettingsToolbarAction
                variant="primary"
                disabled={settingsDisabled() || !recoveryPhrase().trim() || workspaceLoading()}
                onClick={() => void verifyRecoveryPhrase()}
              >
                {workspaceLoading()
                  ? t("settings.plugin.sync.action.working")
                  : t("settings.plugin.sync.passphrase.unlock")}
              </SettingsToolbarAction>
            </Show>
            <SettingsToolbarAction
              disabled={settingsDisabled() || !recoveryPhrase().trim()}
              onClick={() => void copyRecoveryPhrase()}
            >
              {recoveryPhraseCopied()
                ? t("settings.plugin.sync.passphrase.copied")
                : t("settings.plugin.sync.passphrase.copy")}
            </SettingsToolbarAction>
            <SettingsToolbarAction
              disabled={settingsDisabled() || !recoveryPhrase().trim() || recoveryPhraseSaving()}
              onClick={() => void saveRecoveryPhrase()}
            >
              {t("settings.plugin.sync.passphrase.save")}
            </SettingsToolbarAction>
            <SettingsToolbarAction
              disabled={settingsDisabled() || !recoveryPhrase().trim()}
              onClick={() => setShowRecoveryPhrase((prev) => !prev)}
            >
              {showRecoveryPhrase()
                ? t("settings.plugin.sync.passphrase.hide")
                : t("settings.plugin.sync.passphrase.show")}
            </SettingsToolbarAction>
          </div>
          <Show
            when={showRecoveryPhrase()}
            fallback={
              <SettingsInput
                type="password"
                value={recoveryPhrase()}
                onInput={(event) => {
                  setRecoveryPhrase(event.currentTarget.value);
                  setRecoveryPhraseSource(event.currentTarget.value ? "user" : "empty");
                  setRecoveryPhraseBackedUp(false);
                }}
                placeholder={t("settings.plugin.sync.passphrase.placeholder")}
                autocomplete="off"
                disabled={settingsDisabled()}
                spellcheck={false}
              />
            }
          >
            <Show
              when={canCreateAccountRecovery() && recoveryPhraseWords().length > 0}
              fallback={
                <textarea
                  value={recoveryPhrase()}
                  onInput={(event) => {
                    setRecoveryPhrase(event.currentTarget.value);
                    setRecoveryPhraseSource(event.currentTarget.value ? "user" : "empty");
                    setRecoveryPhraseBackedUp(false);
                  }}
                  placeholder={t("settings.plugin.sync.passphrase.placeholder")}
                  class="min-h-24 w-full resize-y rounded-xs border border-border bg-bg-secondary px-3 py-2 text-[0.75rem] text-text-primary transition-colors outline-none placeholder:text-text-muted focus:border-accent"
                  autocomplete="off"
                  disabled={settingsDisabled()}
                  spellcheck={false}
                />
              }
            >
              <div class="grid grid-cols-2 gap-1.5 rounded-xs border border-border/60 bg-bg-secondary p-2 sm:grid-cols-3">
                <For each={recoveryPhraseWords()}>
                  {(word, index) => (
                    <div class="flex items-center gap-2 rounded-xs border border-border/50 bg-bg-primary px-2 py-1.5">
                      <span class="w-5 shrink-0 text-right text-[0.625rem] text-text-muted tabular-nums">
                        {index() + 1}
                      </span>
                      <span class="min-w-0 text-[0.75rem] break-all text-text-primary">{word}</span>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </Show>
          <Show when={requiresRecoveryBackup()}>
            <label
              class={[
                "flex cursor-pointer items-start gap-2 rounded-xs border px-3 py-2 text-[0.6875rem] transition-colors",
                settingsDisabled() ? "cursor-not-allowed opacity-50" : "",
                recoveryPhraseBackedUp()
                  ? "border-border/70 bg-bg-secondary text-text-primary"
                  : "border-border/60 bg-bg-primary/60 text-text-secondary hover:bg-bg-secondary",
              ].join(" ")}
            >
              <span class="kuku-task-checkbox mt-0.5 text-[0.8125rem]">
                <input
                  type="checkbox"
                  checked={recoveryPhraseBackedUp()}
                  onChange={(event) => setRecoveryPhraseBackedUp(event.currentTarget.checked)}
                  class="kuku-task-checkbox__input"
                  disabled={settingsDisabled()}
                />
                <span class="kuku-task-checkbox__control" />
              </span>
              <span class="leading-5">{t("settings.plugin.sync.passphrase.backup_confirm")}</span>
            </label>
          </Show>
        </div>
      </SettingsCard>

      <SettingsCard
        title={t("settings.plugin.sync.status.title")}
        tone="subtle"
        class={disabledCardClass()}
        action={
          <SettingsStatusBadge tone={phaseTone(syncStatus)}>
            {phaseLabel(syncStatus)}
          </SettingsStatusBadge>
        }
      >
        <div class="space-y-1.5">
          <SettingsMetricRow
            label={t("settings.plugin.sync.metrics.vault")}
            value={
              syncStatus.vaultName ||
              basename(syncStatus.rootPath ?? vaultState.rootPath) ||
              t("settings.plugin.sync.metrics.none")
            }
            valueClass="max-w-80 truncate text-right"
          />
          <SettingsMetricRow
            label={t("settings.plugin.sync.metrics.workspace")}
            value={syncStatus.workspaceName ?? t("settings.plugin.sync.metrics.none")}
            valueClass="max-w-80 truncate text-right"
          />
          <SettingsMetricRow
            label={t("settings.plugin.sync.metrics.device")}
            value={syncStatus.deviceName ?? t("settings.plugin.sync.metrics.none")}
            valueClass="max-w-80 truncate text-right"
          />
          <SettingsMetricRow
            label={t("settings.plugin.sync.metrics.last_synced")}
            value={formatTimestamp(syncStatus.lastSyncedAtMs)}
          />
          <SettingsMetricRow
            label={t("settings.plugin.sync.metrics.transfer")}
            value={transferStatusLabel(syncStatus.transfer)}
          />
          <SettingsMetricRow
            label={t("settings.plugin.sync.metrics.conflicts")}
            value={String(syncStatus.conflictCount)}
          />
          <SettingsMetricRow
            label={t("settings.plugin.sync.metrics.pending")}
            value={`${syncStatus.pendingUploads} / ${syncStatus.pendingDownloads}`}
          />
        </div>
      </SettingsCard>

      <SettingsCard
        title={t("settings.plugin.sync.workspace.title")}
        description={t("settings.plugin.sync.workspace.description")}
        tone="subtle"
        class={disabledCardClass()}
        actionClass="shrink-0"
        action={
          <div class="flex flex-nowrap justify-end gap-2">
            <SettingsToolbarAction
              class="whitespace-nowrap"
              onClick={() => void handleCreateWorkspace()}
            >
              {busy()
                ? t("settings.plugin.sync.action.working")
                : t("settings.plugin.sync.workspace.create")}
            </SettingsToolbarAction>
          </div>
        }
      >
        <div class="space-y-2">
          <Show when={workspaceLoading()}>
            <SettingsBanner tone="info" description={t("settings.plugin.sync.workspace.loading")} />
          </Show>
          <Show when={!workspaceLoading() && workspaces().length === 0}>
            <SettingsBanner tone="info" description={t("settings.plugin.sync.workspace.empty")} />
          </Show>
          <For each={workspaces()}>
            {(workspace) => {
              const isEditing = () => renamingWorkspaceId() === workspace.workspaceId;
              const isBusy = () => workspaceBusyId() === workspace.workspaceId;
              const isDeleteConfirm = () => confirmDeleteWorkspaceId() === workspace.workspaceId;
              const isCurrent = () => workspace.current && syncStatus.enabled;
              return (
                <SettingsListRow
                  title={
                    <Show
                      when={isEditing()}
                      fallback={<span class="break-all">{workspace.name}</span>}
                    >
                      <SettingsInput
                        value={workspaceDraftName()}
                        onInput={(event) => setWorkspaceDraftName(event.currentTarget.value)}
                        placeholder={t("settings.plugin.sync.workspace.name_placeholder")}
                        class="h-7 max-w-80 py-1 text-[0.75rem]"
                        disabled={workspaceActionBusy()}
                      />
                    </Show>
                  }
                  description={`${t("settings.plugin.sync.workspace.head_version")} ${workspace.headVersion}`}
                  meta={
                    isCurrent() ? (
                      <SettingsStatusBadge tone="neutral">
                        {t("settings.plugin.sync.workspace.current")}
                      </SettingsStatusBadge>
                    ) : undefined
                  }
                  action={
                    <div class="flex flex-wrap justify-end gap-2">
                      <Show
                        when={isEditing()}
                        fallback={
                          <>
                            <Show
                              when={isCurrent()}
                              fallback={
                                <SettingsToolbarAction
                                  disabled={workspaceActionBusy()}
                                  onClick={() => void connectWorkspace(workspace)}
                                >
                                  {isBusy()
                                    ? t("settings.plugin.sync.action.working")
                                    : t("settings.plugin.sync.workspace.connect")}
                                </SettingsToolbarAction>
                              }
                            >
                              <SettingsToolbarAction
                                variant={currentWorkspaceSyncActionVariant()}
                                disabled={workspaceActionBusy() || busy()}
                                onClick={() => void handleDisable()}
                              >
                                {currentWorkspaceSyncActionLabel()}
                              </SettingsToolbarAction>
                            </Show>
                            <SettingsToolbarAction
                              disabled={workspaceActionBusy()}
                              onClick={() => startRenameWorkspace(workspace)}
                            >
                              {t("settings.plugin.sync.workspace.rename")}
                            </SettingsToolbarAction>
                            <SettingsToolbarAction
                              variant={isDeleteConfirm() ? "destructive" : "default"}
                              disabled={workspaceActionBusy()}
                              onClick={() => void deleteWorkspace(workspace)}
                            >
                              {isDeleteConfirm()
                                ? t("settings.plugin.sync.workspace.confirm_delete")
                                : t("settings.plugin.sync.workspace.delete")}
                            </SettingsToolbarAction>
                          </>
                        }
                      >
                        <SettingsToolbarAction
                          variant="primary"
                          disabled={workspaceActionBusy()}
                          onClick={() => void saveWorkspaceRename(workspace)}
                        >
                          {isBusy()
                            ? t("settings.plugin.sync.action.working")
                            : t("settings.plugin.sync.workspace.save")}
                        </SettingsToolbarAction>
                        <SettingsToolbarAction
                          disabled={workspaceActionBusy()}
                          onClick={() => {
                            setRenamingWorkspaceId(null);
                            setWorkspaceDraftName("");
                          }}
                        >
                          {t("settings.plugin.sync.workspace.cancel")}
                        </SettingsToolbarAction>
                      </Show>
                    </div>
                  }
                />
              );
            }}
          </For>
          <div class="flex flex-wrap justify-end gap-2 border-t border-border/60 pt-3">
            <SettingsToolbarAction
              class="whitespace-nowrap"
              disabled={workspaceActionBusy()}
              onClick={() => void refreshWorkspaceAndRemoteStatus()}
            >
              {workspaceLoading()
                ? t("settings.plugin.sync.action.working")
                : t("settings.plugin.sync.action.refresh")}
            </SettingsToolbarAction>
            <SettingsToolbarAction
              class="whitespace-nowrap"
              disabled={!canSyncNow()}
              onClick={() => void handleSyncNow()}
            >
              {busy()
                ? t("settings.plugin.sync.action.working")
                : t("settings.plugin.sync.action.sync_now")}
            </SettingsToolbarAction>
            <SettingsToolbarAction
              variant="destructive"
              class="whitespace-nowrap"
              disabled={!canRebuildSyncState()}
              onClick={() => void handleRebuildSyncState()}
            >
              {busy()
                ? t("settings.plugin.sync.action.working")
                : t("settings.plugin.sync.action.rebuild_state")}
            </SettingsToolbarAction>
          </div>
        </div>
      </SettingsCard>

      <SettingsCard
        title={t("settings.plugin.sync.conflicts.title")}
        description={t("settings.plugin.sync.conflicts.description")}
        tone="subtle"
        class={disabledCardClass()}
      >
        <ConflictList disabled={settingsDisabled()} />
      </SettingsCard>
    </SettingsPanel>
  );
}

export { SyncSettings };
