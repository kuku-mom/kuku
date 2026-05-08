import { createMemo, createSignal, onCleanup, Show, type JSX } from "solid-js";

import { t, tf } from "~/i18n";
import { openSettings } from "~/stores/files";

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

const PILL_BASE =
  "group relative inline-flex h-6 max-w-[11rem] cursor-pointer select-none items-center gap-1.5 overflow-hidden rounded-xs border px-2.5 text-[0.6875rem] font-medium transition-colors duration-150";
const PILL_SURFACE =
  "bg-bg-primary/45 text-text-muted shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] hover:bg-bg-primary/65 hover:text-text-secondary";

function SyncStatusIndicator(): JSX.Element {
  const [open, setOpen] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [refreshing, setRefreshing] = createSignal(false);
  const [nowMs, setNowMs] = createSignal(Date.now());
  const [localErrorCategory, setLocalErrorCategory] = createSignal<SyncErrorCategory | null>(null);
  let rootRef: HTMLDivElement | undefined;

  const indicator = createMemo(() => syncIndicatorState(syncStatus, nowMs()));
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
    <Show when={indicator().visible}>
      <div ref={rootRef} class="relative">
        <button
          type="button"
          class={`${PILL_BASE} ${toneClass(displayTone())}`}
          onClick={() => setOpen((value) => !value)}
          title={title()}
          aria-label={title()}
          aria-haspopup="dialog"
          aria-expanded={open()}
        >
          <Show when={working()} fallback={<DotIndicator tone={displayTone()} />}>
            <Spinner />
          </Show>
          <span class="min-w-0 truncate">{label()}</span>
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
    </Show>
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
      role="dialog"
      class="absolute top-8 right-0 z-50 flex w-76 flex-col rounded-sm border border-border/70 bg-bg-secondary/95 p-3 text-xs text-text-secondary shadow-xl"
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

function toneClass(tone: SyncIndicatorState["tone"]): string {
  switch (tone) {
    case "warning":
      return `border-warning-border ${PILL_SURFACE}`;
    case "error":
      return `border-error-border ${PILL_SURFACE}`;
    default:
      return `border-border/70 ${PILL_SURFACE}`;
  }
}

function DotIndicator(props: { tone: SyncIndicatorState["tone"] }): JSX.Element {
  const color = () => {
    switch (props.tone) {
      case "warning":
        return "bg-warning";
      case "error":
        return "bg-error";
      default:
        return "bg-text-muted";
    }
  };

  return <span class={`size-1.5 shrink-0 rounded-full ${color()}`} aria-hidden="true" />;
}

function Spinner(): JSX.Element {
  return (
    <svg
      aria-hidden="true"
      width="10"
      height="10"
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
