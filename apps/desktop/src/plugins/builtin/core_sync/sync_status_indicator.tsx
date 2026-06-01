import { createMemo, createSignal, Match, onCleanup, Show, Switch, type JSX } from "solid-js";

import { t, tf } from "~/i18n";
import { openSettings } from "~/stores/files";
import { layoutState } from "~/stores/layout";
import { checkForUpdates, downloadAndInstall, restart, updaterState } from "~/stores/updater";

import { getSyncService } from "./runtime";
import { mapSyncError } from "./service";
import {
  applySyncRemoteStatus,
  refreshSyncStatus,
  syncRemoteStatus,
  syncStatus,
} from "./status_store";
import { syncIndicatorState, type SyncIndicatorState } from "./sync_status_indicator_state";
import { transferStatusLabel } from "./transfer_status";
import type { SyncErrorCategory, SyncPhase, SyncRemoteStatus, SyncRuntimeStatus } from "./types";

const ICON_BUTTON_BASE =
  "inline-flex size-8 cursor-pointer items-center justify-center rounded-tl-md rounded-tr-none rounded-br-none rounded-bl-none border-t border-l border-r-0 border-b-0 transition-colors duration-150 active:scale-[0.96]";
const RIGHT_PANEL_RESIZE_HANDLE_PX = 1;

function syncIndicatorRightInset(): string {
  if (!layoutState.rightPanelOpen) return "0px";
  return `${layoutState.rightPanelWidth + RIGHT_PANEL_RESIZE_HANDLE_PX}px`;
}

function SyncStatusIndicator(): JSX.Element {
  const [open, setOpen] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [refreshing, setRefreshing] = createSignal(false);
  const [nowMs, setNowMs] = createSignal(Date.now());
  const [localErrorCategory, setLocalErrorCategory] = createSignal<SyncErrorCategory | null>(null);
  let rootRef: HTMLDivElement | undefined;

  const indicator = createMemo<SyncIndicatorState>(() => {
    const state = syncIndicatorState(syncStatus, nowMs());
    if (state.visible) return state;
    return { kind: "notConfigured", visible: true, tone: "neutral", active: false };
  });
  const label = createMemo(
    () =>
      syncErrorLabel(localErrorCategory()) ??
      remoteChangeLabel(indicator(), syncRemoteStatus()) ??
      syncIndicatorLabel(indicator(), syncStatus),
  );
  const title = createMemo(() => `${label()} · ${t("sync.indicator.open_widget")}`);
  const working = () => indicator().active || busy() || refreshing();
  const canSync = () => syncStatus.configured && syncStatus.enabled && !working();
  const canRefresh = () => !refreshing();
  const displayTone = () => (localErrorCategory() ? "error" : indicator().tone);
  const visibleError = () =>
    syncErrorCopy(
      localErrorCategory() ?? syncStatus.lastErrorCategory,
      syncStatus.phase,
      syncStatus.lastError,
    );

  function handleWindowPointerDown(event: PointerEvent): void {
    if (!rootRef?.contains(event.target as Node)) {
      setOpen(false);
    }
  }

  window.addEventListener("pointerdown", handleWindowPointerDown);
  const clockTimer = window.setInterval(() => setNowMs(Date.now()), 500);
  onCleanup(() => {
    window.removeEventListener("pointerdown", handleWindowPointerDown);
    window.clearInterval(clockTimer);
  });

  async function syncNow(): Promise<void> {
    const service = getSyncService();
    if (!service || !canSync()) return;

    setBusy(true);
    setLocalErrorCategory(null);
    try {
      await service.runOnce();
      await refreshSyncStatus(service, { scanLocal: true });
      try {
        applySyncRemoteStatus(await service.getRemoteStatus());
      } catch {
        // Keep the previous remote snapshot when sync succeeded but status refresh failed.
      }
    } catch (error) {
      setLocalErrorCategory(mapSyncError(error));
      await refreshSyncStatus(service, { scanLocal: true });
    } finally {
      setBusy(false);
    }
  }

  async function refreshLatestStatus(): Promise<void> {
    const service = getSyncService();
    if (!service || !canRefresh()) return;

    setRefreshing(true);
    setLocalErrorCategory(null);
    try {
      const authState = await service.authState();
      if (authState === "loginRequired") {
        setLocalErrorCategory("loginRequired");
        return;
      }
      if (authState === "permissionRequired") {
        setLocalErrorCategory("permissionRequired");
        return;
      }

      applySyncRemoteStatus(await service.getRemoteStatus());
      const refreshed = await refreshSyncStatus(service, { scanLocal: true });
      if (!refreshed) {
        setLocalErrorCategory("unknown");
      }
    } catch (error) {
      setLocalErrorCategory(mapSyncError(error));
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div
      ref={rootRef}
      class="pointer-events-auto fixed bottom-0"
      style={{ right: syncIndicatorRightInset() }}
    >
      <button
        type="button"
        data-kuku-sync-status-icon="true"
        class={`${ICON_BUTTON_BASE} ${statusIconClass(indicator(), displayTone())}`}
        onClick={() => setOpen((value) => !value)}
        title={title()}
        aria-label={title()}
        aria-haspopup="dialog"
        aria-expanded={open()}
      >
        <Show when={working()} fallback={<SyncStatusGlyph kind={indicator().kind} />}>
          <Spinner />
        </Show>
      </button>

      <Show when={open()}>
        <SyncWidget
          label={label()}
          busy={busy()}
          refreshing={refreshing()}
          remoteStatus={syncRemoteStatus()}
          canRefresh={canRefresh()}
          canSync={canSync()}
          error={visibleError()}
          onClose={() => setOpen(false)}
          onRefresh={() => void refreshLatestStatus()}
          onSyncNow={() => void syncNow()}
        />
      </Show>
    </div>
  );
}

function openSyncSettings(): void {
  openSettings({ kind: "plugin", fillId: "core-sync.settings" });
}

function syncIndicatorLabel(indicator: SyncIndicatorState, status: SyncRuntimeStatus): string {
  switch (indicator.kind) {
    case "idle":
      return t("sync.indicator.idle");
    case "pending":
      return t("sync.indicator.pending");
    case "syncing":
    case "transferring":
      return t("sync.indicator.syncing");
    case "uploading":
      return tf("sync.indicator.uploading", {
        completed: status.transfer.uploadCompletedObjects,
        total: status.transfer.uploadTotalObjects,
      });
    case "downloading":
      return tf("sync.indicator.downloading", {
        completed: status.transfer.downloadCompletedObjects,
        total: status.transfer.downloadTotalObjects,
      });
    case "retryingUpload":
      return tf("sync.indicator.retrying_upload", {
        attempt: status.transfer.retryAttempt ?? 1,
        max: status.transfer.maxAttempts ?? status.transfer.retryAttempt ?? 1,
      });
    case "retryingDownload":
      return tf("sync.indicator.retrying_download", {
        attempt: status.transfer.retryAttempt ?? 1,
        max: status.transfer.maxAttempts ?? status.transfer.retryAttempt ?? 1,
      });
    case "conflict":
      return tf("sync.indicator.conflicts", { count: status.conflictCount });
    case "notConfigured":
      return t("sync.indicator.not_configured");
    case "loginRequired":
      return t("sync.indicator.login_required");
    case "permissionRequired":
      return t("sync.indicator.permission_required");
    case "syncDisabled":
      return t("sync.indicator.sync_disabled");
    case "offline":
      return t("sync.indicator.offline");
    case "passphraseFailed":
      return t("sync.indicator.passphrase_failed");
    case "quotaExceeded":
      return t("sync.indicator.quota");
    case "serverError":
      return t("sync.indicator.server");
    case "unknownError":
      return t("sync.indicator.error");
    default:
      return t("settings.plugin.sync.title");
  }
}

function remoteChangeLabel(
  indicator: SyncIndicatorState,
  remoteStatus: SyncRemoteStatus | null,
): string | null {
  if (indicator.kind !== "idle" || !remoteStatus?.hasRemoteChanges) return null;
  return t("sync.indicator.remote.changed");
}

function SyncWidget(props: {
  label: string;
  busy: boolean;
  refreshing: boolean;
  remoteStatus: SyncRemoteStatus | null;
  canRefresh: boolean;
  canSync: boolean;
  error: string | null;
  onClose: () => void;
  onRefresh: () => void;
  onSyncNow: () => void;
}): JSX.Element {
  return (
    <div
      data-kuku-sync-status-popover="true"
      role="dialog"
      class="absolute right-0 bottom-7 z-1000 flex w-78 flex-col rounded-sm border border-border/70 bg-bg-elevated/96 p-3 text-xs text-text-secondary shadow-popover backdrop-blur-sm"
    >
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <div class="font-medium text-text-primary">{t("settings.plugin.sync.title")}</div>
          <div class="mt-0.5 truncate text-[0.6875rem] text-text-muted">
            {syncStatus.rootPath ?? t("settings.plugin.sync.metrics.none")}
          </div>
        </div>
        <span class="shrink-0 rounded-xs border border-border/70 bg-bg-primary/55 px-1.5 py-0.5 text-[0.625rem] text-text-muted">
          {phaseLabel(syncStatus.phase, props.label)}
        </span>
      </div>

      <Show when={props.error}>
        {(error) => (
          <div class="mt-3 rounded-xs border border-error-border bg-error-bg px-2 py-1.5 text-[0.6875rem] text-error">
            {error()}
          </div>
        )}
      </Show>

      <div class="mt-3 grid grid-cols-2 gap-2 text-[0.6875rem]">
        <WidgetMetric label={t("settings.plugin.sync.status.title")} value={props.label} />
        <WidgetMetric
          label={t("settings.plugin.sync.metrics.remote")}
          value={remoteStatusLabel(props.remoteStatus)}
        />
        <WidgetMetric
          label={t("settings.plugin.sync.metrics.transfer")}
          value={transferStatusLabel(syncStatus.transfer)}
        />
        <WidgetMetric
          label={t("settings.plugin.sync.metrics.last_synced")}
          value={formatTimestamp(syncStatus.lastSyncedAtMs)}
        />
        <WidgetMetric
          label={t("settings.plugin.sync.metrics.conflicts")}
          value={String(syncStatus.conflictCount)}
        />
        <WidgetMetric
          label={t("settings.plugin.sync.metrics.pending")}
          value={`${syncStatus.pendingUploads} / ${syncStatus.pendingDownloads}`}
        />
      </div>

      <UpdateStatusRow />

      <div class="mt-3 flex flex-wrap items-center justify-end gap-2">
        <button
          type="button"
          class="cursor-pointer rounded-xs border border-border bg-transparent px-2 py-1 text-[0.6875rem] text-text-muted hover:bg-ghost-hover hover:text-text-secondary"
          onClick={() => {
            props.onClose();
            openSyncSettings();
          }}
        >
          {t("sync.indicator.open_settings")}
        </button>
        <button
          type="button"
          disabled={!props.canRefresh}
          class="cursor-pointer rounded-xs border border-border bg-bg-primary/40 px-2 py-1 text-[0.6875rem] text-text-muted hover:bg-bg-primary/65 hover:text-text-secondary disabled:cursor-not-allowed disabled:opacity-50"
          onClick={props.onRefresh}
        >
          {props.refreshing
            ? t("settings.plugin.sync.action.working")
            : t("settings.plugin.sync.action.refresh")}
        </button>
        <button
          type="button"
          disabled={!props.canSync}
          class="cursor-pointer rounded-xs border border-border bg-bg-primary/55 px-2 py-1 text-[0.6875rem] font-medium text-text-secondary hover:bg-bg-primary/75 disabled:cursor-not-allowed disabled:opacity-50"
          onClick={props.onSyncNow}
        >
          {props.busy
            ? t("settings.plugin.sync.action.working")
            : t("settings.plugin.sync.action.sync_now")}
        </button>
      </div>
    </div>
  );
}

function UpdateStatusRow(): JSX.Element {
  const actionLabel = createMemo(() => updateActionLabel());

  return (
    <div
      data-kuku-status-popover-update="true"
      class="mt-3 flex min-w-0 items-center justify-between gap-3 border-t border-border/60 pt-3 text-[0.6875rem]"
    >
      <div class="min-w-0">
        <div class="font-medium text-text-secondary">{t("status_bar.update.title")}</div>
        <div class="mt-0.5 truncate text-text-muted">{updateStatusLabel()}</div>
      </div>
      <Show when={actionLabel()}>
        {(label) => (
          <button
            type="button"
            class="shrink-0 cursor-pointer rounded-xs border border-border bg-bg-primary/45 px-2 py-1 text-[0.6875rem] text-text-muted hover:bg-bg-primary/65 hover:text-text-secondary"
            onClick={() => void handleUpdateAction()}
          >
            {label()}
          </button>
        )}
      </Show>
    </div>
  );
}

function WidgetMetric(props: { label: string; value: string }): JSX.Element {
  return (
    <div class="flex min-h-13 min-w-0 flex-col justify-center rounded-xs border border-border/60 bg-bg-primary/50 px-2 py-1.5">
      <div class="text-[0.625rem] text-text-muted">{props.label}</div>
      <div class="mt-0.5 truncate font-mono text-[0.6875rem] text-text-secondary tabular-nums">
        {props.value}
      </div>
    </div>
  );
}

function phaseLabel(phase: SyncPhase, currentLabel?: string): string {
  if (phase === "idle" && currentLabel) return currentLabel;
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

function formatTimestamp(ts?: number): string {
  if (!ts) return t("settings.plugin.sync.metrics.never");
  return new Date(ts).toLocaleString();
}

function remoteStatusLabel(status: SyncRemoteStatus | null): string {
  if (!status) return t("settings.plugin.sync.metrics.none");
  const state = status.hasRemoteChanges
    ? t("sync.indicator.remote.changed")
    : t("sync.indicator.remote.current");
  const version = status.remoteHeadVersion > 0 ? `v${status.remoteHeadVersion}` : "";
  return version ? `${state} · ${version}` : state;
}

function syncErrorLabel(category: SyncErrorCategory | null): string | null {
  switch (category) {
    case "loginRequired":
      return t("sync.indicator.login_required");
    case "permissionRequired":
      return t("sync.indicator.permission_required");
    case "syncDisabled":
      return t("sync.indicator.sync_disabled");
    case "notConfigured":
      return t("sync.indicator.not_configured");
    case "offline":
      return t("sync.indicator.offline");
    case "passphraseFailed":
      return t("sync.indicator.passphrase_failed");
    case "quotaExceeded":
      return t("sync.indicator.quota");
    case "server":
      return t("sync.indicator.server");
    case "unknown":
      return t("sync.indicator.error");
    default:
      return null;
  }
}

function syncErrorCopy(
  category: SyncErrorCategory | undefined,
  phase: SyncPhase,
  message?: string,
): string | null {
  if (!category && phase !== "error") return null;
  switch (category) {
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
      return message?.trim() || t("settings.plugin.sync.error.quota");
    case "server":
      return t("settings.plugin.sync.error.server");
    default:
      return t("settings.plugin.sync.error.unknown");
  }
}

function statusIconClass(
  indicator: SyncIndicatorState,
  tone: SyncIndicatorState["tone"],
): string {
  if (tone === "error" || indicator.kind.endsWith("Error") || indicator.kind === "offline") {
    return "border-error-border bg-error-bg text-error hover:brightness-110";
  }
  if (tone === "warning" || indicator.kind === "conflict" || indicator.kind === "pending") {
    return "border-warning-border bg-warning-bg text-warning hover:brightness-110";
  }
  if (indicator.active) {
    return "border-info-border bg-info-bg text-info hover:brightness-110";
  }
  if (indicator.kind === "idle") {
    return "border-success-border bg-success-bg text-success hover:brightness-110";
  }
  return "border-border/70 bg-bg-primary/45 text-text-muted hover:bg-bg-primary/65 hover:text-text-secondary";
}

function updateStatusLabel(): string {
  switch (updaterState.status) {
    case "checking":
      return t("status_bar.update.checking");
    case "available":
      return tf("status_bar.update.available", { version: updaterState.version ?? "latest" });
    case "downloading":
      return tf("status_bar.update.downloading", {
        progress: Math.round(updaterState.progress),
      });
    case "ready":
      return t("status_bar.update.ready");
    case "error":
      return updaterState.errorMessage ?? t("status_bar.update.error");
    default:
      return t("status_bar.update.idle");
  }
}

function updateActionLabel(): string | null {
  switch (updaterState.status) {
    case "available":
      return t("updater.action.update");
    case "ready":
      return t("updater.action.restart_to_update");
    case "error":
    case "idle":
      return t("status_bar.update.check");
    default:
      return null;
  }
}

async function handleUpdateAction(): Promise<void> {
  switch (updaterState.status) {
    case "available":
      await downloadAndInstall();
      return;
    case "ready":
      await restart();
      return;
    case "error":
    case "idle":
      await checkForUpdates();
      return;
    default:
      return;
  }
}

function SyncStatusGlyph(props: { kind: SyncIndicatorState["kind"] }): JSX.Element {
  return (
    <svg
      aria-hidden="true"
      width="15"
      height="15"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      class="shrink-0"
    >
      <Switch
        fallback={
          <>
            <circle cx="8" cy="8" r="4.75" />
            <path d="M8 5.5v3" />
            <path d="M8 11h.01" />
          </>
        }
      >
        <Match when={props.kind === "idle"}>
          <circle cx="8" cy="8" r="4.75" />
          <path d="m5.6 8.1 1.55 1.55L10.7 6.2" />
        </Match>
        <Match when={props.kind === "pending" || props.kind === "conflict"}>
          <circle cx="8" cy="8" r="4.75" />
          <path d="M8 5.2v3.1l2 1.1" />
        </Match>
        <Match when={props.kind === "notConfigured" || props.kind === "syncDisabled"}>
          <circle cx="8" cy="8" r="4.75" />
          <path d="M5.7 8h4.6" />
        </Match>
      </Switch>
    </svg>
  );
}

function Spinner(): JSX.Element {
  return (
    <svg
      aria-hidden="true"
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      class="shrink-0 animate-spin"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2.5" opacity="0.22" />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        stroke-width="2.5"
        stroke-linecap="round"
      />
    </svg>
  );
}

export { SyncStatusIndicator, syncIndicatorLabel };
