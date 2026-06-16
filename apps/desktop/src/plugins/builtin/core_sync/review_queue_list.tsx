import { For, Show, createSignal, onMount, type JSX } from "solid-js";

import {
  SettingsBanner,
  SettingsInput,
  SettingsListRow,
  SettingsStatusBadge,
  SettingsToolbarAction,
} from "~/components/settings/settings_blocks";
import { t } from "~/i18n";

import { getSyncService } from "./runtime";
import { openSyncReviewDiff } from "./review_diff";
import {
  acceptImportCommand,
  canOpenReviewDiff,
  defaultRecoveryRestorePath,
  deleteEditFileId,
  keepDeleteCommand,
  rejectImportCommand,
  recoverySnapshotDescription,
  recoverySnapshotPath,
  renameActionKey,
  renameFileCommand,
  renameFileIds,
  restoreRecoverySnapshotRequest,
  restoreEditedVersionCommand,
  retryMissingObjectCommand,
  reviewItemDescription,
  reviewItemPath,
} from "./review_queue_model";
import { applySyncReviewQueue, refreshSyncStatus, syncReviewQueue } from "./status_store";
import type {
  SyncRecoverySnapshot,
  SyncRecoverySnapshotSet,
  SyncReviewItem,
  SyncReviewResolutionCommand,
} from "./types";

interface ReviewQueueListProps {
  disabled?: boolean;
}

function ReviewQueueList(props: ReviewQueueListProps = {}): JSX.Element {
  const [localError, setLocalError] = createSignal<string | null>(null);
  const [busyReviewItemId, setBusyReviewItemId] = createSignal<string | null>(null);
  const [busyRecoverySnapshotId, setBusyRecoverySnapshotId] = createSignal<string | null>(null);
  const [renamingKey, setRenamingKey] = createSignal<string | null>(null);
  const [renameDraft, setRenameDraft] = createSignal("");
  const [recoverySnapshotSet, setRecoverySnapshotSet] = createSignal<SyncRecoverySnapshotSet>({
    snapshots: [],
    unavailable: [],
  });
  const [restoringSnapshotId, setRestoringSnapshotId] = createSignal<string | null>(null);
  const [restoreDraft, setRestoreDraft] = createSignal("");

  const actionDisabled = () =>
    Boolean(props.disabled || busyReviewItemId() !== null || busyRecoverySnapshotId() !== null);

  onMount(() => {
    void refreshRecoverySnapshots();
  });

  async function openReviewDiff(item: SyncReviewItem): Promise<void> {
    const service = getSyncService();
    if (!service || props.disabled || !canOpenReviewDiff(item)) return;
    setLocalError(null);
    setBusyReviewItemId(item.id);
    try {
      await openSyncReviewDiff(service, item.id);
    } catch {
      setLocalError(t("settings.plugin.sync.review.open_failed"));
    } finally {
      setBusyReviewItemId(null);
    }
  }

  async function resolveReview(command: SyncReviewResolutionCommand): Promise<void> {
    const service = getSyncService();
    if (!service || props.disabled) return;
    setLocalError(null);
    setBusyReviewItemId(command.reviewItemId);
    try {
      applySyncReviewQueue(await service.resolveReviewItem(command));
      setRenamingKey(null);
      setRenameDraft("");
      await refreshSyncStatus(service, { scanLocal: true });
      await refreshRecoverySnapshots();
    } catch {
      setLocalError(t("settings.plugin.sync.review.resolve_failed"));
    } finally {
      setBusyReviewItemId(null);
    }
  }

  function startRename(item: SyncReviewItem, fileId: string): void {
    if (props.disabled) return;
    setRenamingKey(renameActionKey(item, fileId));
    setRenameDraft(reviewItemPath(item));
  }

  async function saveRename(item: SyncReviewItem, fileId: string): Promise<void> {
    const newDisplayPath = renameDraft().trim();
    if (!newDisplayPath) {
      setLocalError(t("settings.plugin.sync.review.rename_required"));
      return;
    }
    const command = renameFileCommand(item, fileId, newDisplayPath);
    if (!command) {
      setLocalError(t("settings.plugin.sync.review.rename_required"));
      return;
    }
    await resolveReview(command);
  }

  async function refreshRecoverySnapshots(): Promise<void> {
    const service = getSyncService();
    if (!service || props.disabled) return;
    try {
      setRecoverySnapshotSet(await service.getRecoverySnapshots());
    } catch {
      setLocalError(t("settings.plugin.sync.review.recovery_load_failed"));
    }
  }

  function startRecoveryRestore(snapshot: SyncRecoverySnapshot): void {
    if (props.disabled) return;
    setRestoringSnapshotId(snapshot.id);
    setRestoreDraft(defaultRecoveryRestorePath(snapshot));
  }

  async function saveRecoveryRestore(snapshot: SyncRecoverySnapshot): Promise<void> {
    const service = getSyncService();
    if (!service || props.disabled) return;
    const request = restoreRecoverySnapshotRequest(snapshot, restoreDraft());
    if (!request) {
      setLocalError(t("settings.plugin.sync.review.restore_path_required"));
      return;
    }
    setLocalError(null);
    setBusyRecoverySnapshotId(snapshot.id);
    try {
      setRecoverySnapshotSet(await service.restoreRecoverySnapshot(request));
      setRestoringSnapshotId(null);
      setRestoreDraft("");
      await refreshSyncStatus(service, { scanLocal: true });
    } catch {
      setLocalError(t("settings.plugin.sync.review.restore_failed"));
    } finally {
      setBusyRecoverySnapshotId(null);
    }
  }

  return (
    <div class="space-y-2">
      <Show when={localError()}>
        {(message) => <SettingsBanner tone="error" description={message()} />}
      </Show>
      <Show
        when={syncReviewQueue.items.length > 0}
        fallback={
          <SettingsBanner tone="success" description={t("settings.plugin.sync.review.empty")} />
        }
      >
        <div class="space-y-2">
          <For each={syncReviewQueue.items}>
            {(item) => (
              <SettingsListRow
                title={<span class="break-all">{reviewItemPath(item)}</span>}
                description={
                  <span class="break-all">
                    {reviewItemDescription(item)}
                    <span class="text-text-muted/70"> · {item.id}</span>
                  </span>
                }
                meta={
                  <SettingsStatusBadge tone="neutral">
                    {reviewItemKindLabel(item)}
                  </SettingsStatusBadge>
                }
                action={
                  <div class="flex max-w-96 flex-wrap items-center justify-end gap-2">
                    <Show when={canOpenReviewDiff(item)}>
                      <SettingsToolbarAction
                        disabled={actionDisabled()}
                        onClick={() => void openReviewDiff(item)}
                      >
                        {t("settings.plugin.sync.review.open_diff")}
                      </SettingsToolbarAction>
                    </Show>
                    <ReviewResolutionActions
                      item={item}
                      disabled={actionDisabled()}
                      renamingKey={renamingKey()}
                      renameDraft={renameDraft()}
                      onRenameDraft={setRenameDraft}
                      onStartRename={startRename}
                      onCancelRename={() => {
                        setRenamingKey(null);
                        setRenameDraft("");
                      }}
                      onSaveRename={(fileId) => void saveRename(item, fileId)}
                      onResolve={(command) => void resolveReview(command)}
                    />
                  </div>
                }
              />
            )}
          </For>
        </div>
      </Show>
      <RecoverySnapshotRows
        snapshots={recoverySnapshotSet().snapshots}
        unavailableCount={recoverySnapshotSet().unavailable.length}
        disabled={actionDisabled()}
        restoringSnapshotId={restoringSnapshotId()}
        restoreDraft={restoreDraft()}
        onRestoreDraft={setRestoreDraft}
        onStartRestore={startRecoveryRestore}
        onCancelRestore={() => {
          setRestoringSnapshotId(null);
          setRestoreDraft("");
        }}
        onSaveRestore={(snapshot) => void saveRecoveryRestore(snapshot)}
      />
    </div>
  );
}

function RecoverySnapshotRows(props: {
  snapshots: readonly SyncRecoverySnapshot[];
  unavailableCount: number;
  disabled: boolean;
  restoringSnapshotId: string | null;
  restoreDraft: string;
  onRestoreDraft: (value: string) => void;
  onStartRestore: (snapshot: SyncRecoverySnapshot) => void;
  onCancelRestore: () => void;
  onSaveRestore: (snapshot: SyncRecoverySnapshot) => void;
}): JSX.Element {
  return (
    <Show when={props.snapshots.length > 0 || props.unavailableCount > 0}>
      <div class="space-y-2 pt-2">
        <Show when={props.unavailableCount > 0}>
          <SettingsBanner
            tone="warning"
            description={t("settings.plugin.sync.review.recovery_unavailable")}
          />
        </Show>
        <For each={props.snapshots}>
          {(snapshot) => (
            <SettingsListRow
              title={<span class="break-all">{recoverySnapshotPath(snapshot)}</span>}
              description={
                <span class="break-all">
                  {recoverySnapshotDescription(snapshot)}
                  <span class="text-text-muted/70"> · {snapshot.id}</span>
                </span>
              }
              meta={
                <SettingsStatusBadge tone="info">
                  {recoverySnapshotKindLabel(snapshot)}
                </SettingsStatusBadge>
              }
              action={
                <RecoverySnapshotActions
                  snapshot={snapshot}
                  disabled={props.disabled}
                  restoring={props.restoringSnapshotId === snapshot.id}
                  restoreDraft={props.restoreDraft}
                  onRestoreDraft={props.onRestoreDraft}
                  onStartRestore={props.onStartRestore}
                  onCancelRestore={props.onCancelRestore}
                  onSaveRestore={props.onSaveRestore}
                />
              }
            />
          )}
        </For>
      </div>
    </Show>
  );
}

function RecoverySnapshotActions(props: {
  snapshot: SyncRecoverySnapshot;
  disabled: boolean;
  restoring: boolean;
  restoreDraft: string;
  onRestoreDraft: (value: string) => void;
  onStartRestore: (snapshot: SyncRecoverySnapshot) => void;
  onCancelRestore: () => void;
  onSaveRestore: (snapshot: SyncRecoverySnapshot) => void;
}): JSX.Element {
  return (
    <Show
      when={props.restoring}
      fallback={
        <SettingsToolbarAction
          disabled={props.disabled}
          onClick={() => props.onStartRestore(props.snapshot)}
        >
          {t("settings.plugin.sync.review.restore_snapshot")}
        </SettingsToolbarAction>
      }
    >
      <div class="flex min-w-52 max-w-full flex-wrap items-center justify-end gap-2">
        <SettingsInput
          value={props.restoreDraft}
          onInput={(event) => props.onRestoreDraft(event.currentTarget.value)}
          placeholder={t("settings.plugin.sync.review.restore_placeholder")}
          class="h-7 w-48 py-1 text-[0.75rem]"
          disabled={props.disabled}
        />
        <SettingsToolbarAction
          variant="primary"
          disabled={props.disabled}
          onClick={() => props.onSaveRestore(props.snapshot)}
        >
          {t("settings.plugin.sync.review.restore_save")}
        </SettingsToolbarAction>
        <SettingsToolbarAction disabled={props.disabled} onClick={props.onCancelRestore}>
          {t("settings.plugin.sync.review.cancel")}
        </SettingsToolbarAction>
      </div>
    </Show>
  );
}

function ReviewResolutionActions(props: {
  item: SyncReviewItem;
  disabled: boolean;
  renamingKey: string | null;
  renameDraft: string;
  onRenameDraft: (value: string) => void;
  onStartRename: (item: SyncReviewItem, fileId: string) => void;
  onCancelRename: () => void;
  onSaveRename: (fileId: string) => void;
  onResolve: (command: SyncReviewResolutionCommand) => void;
}): JSX.Element {
  return (
    <>
      <Show when={props.item.kind === "import"}>
        <SettingsToolbarAction
          variant="primary"
          disabled={props.disabled}
          onClick={() => {
            const command = acceptImportCommand(props.item);
            if (command) props.onResolve(command);
          }}
        >
          {t("settings.plugin.sync.review.accept_import")}
        </SettingsToolbarAction>
        <SettingsToolbarAction
          disabled={props.disabled}
          onClick={() => {
            const command = rejectImportCommand(props.item);
            if (command) props.onResolve(command);
          }}
        >
          {t("settings.plugin.sync.review.reject_import")}
        </SettingsToolbarAction>
      </Show>

      <Show when={deleteEditFileId(props.item) !== null}>
        {() => (
          <>
            <SettingsToolbarAction
              variant="destructive"
              disabled={props.disabled}
              onClick={() => {
                const command = keepDeleteCommand(props.item);
                if (command) props.onResolve(command);
              }}
            >
              {t("settings.plugin.sync.review.keep_delete")}
            </SettingsToolbarAction>
            <SettingsToolbarAction
              variant="primary"
              disabled={props.disabled}
              onClick={() => {
                const command = restoreEditedVersionCommand(props.item);
                if (command) props.onResolve(command);
              }}
            >
              {t("settings.plugin.sync.review.restore_edited")}
            </SettingsToolbarAction>
          </>
        )}
      </Show>

      <For each={renameFileIds(props.item)}>
        {(fileId) => {
          const key = () => renameActionKey(props.item, fileId);
          return (
            <Show
              when={props.renamingKey === key()}
              fallback={
                <SettingsToolbarAction
                  disabled={props.disabled}
                  onClick={() => props.onStartRename(props.item, fileId)}
                >
                  {t("settings.plugin.sync.review.rename")}
                </SettingsToolbarAction>
              }
            >
              <div class="flex min-w-52 max-w-full flex-wrap items-center justify-end gap-2">
                <SettingsInput
                  value={props.renameDraft}
                  onInput={(event) => props.onRenameDraft(event.currentTarget.value)}
                  placeholder={t("settings.plugin.sync.review.rename_placeholder")}
                  class="h-7 w-48 py-1 text-[0.75rem]"
                  disabled={props.disabled}
                />
                <SettingsToolbarAction
                  variant="primary"
                  disabled={props.disabled}
                  onClick={() => props.onSaveRename(fileId)}
                >
                  {t("settings.plugin.sync.review.save_rename")}
                </SettingsToolbarAction>
                <SettingsToolbarAction disabled={props.disabled} onClick={props.onCancelRename}>
                  {t("settings.plugin.sync.review.cancel")}
                </SettingsToolbarAction>
              </div>
            </Show>
          );
        }}
      </For>

      <Show when={props.item.kind === "missingObject"}>
        <SettingsToolbarAction
          disabled={props.disabled}
          onClick={() => {
            const command = retryMissingObjectCommand(props.item);
            if (command) props.onResolve(command);
          }}
        >
          {t("settings.plugin.sync.review.retry")}
        </SettingsToolbarAction>
      </Show>
    </>
  );
}

function reviewItemKindLabel(item: SyncReviewItem): string {
  switch (item.kind) {
    case "import":
      return t("settings.plugin.sync.review.kind.import");
    case "projectionBlocked":
      return t("settings.plugin.sync.review.kind.projection_blocked");
    case "conflict":
      return t("settings.plugin.sync.review.kind.conflict");
    case "missingObject":
      return t("settings.plugin.sync.review.kind.missing_object");
  }
}

function recoverySnapshotKindLabel(snapshot: SyncRecoverySnapshot): string {
  switch (snapshot.kind) {
    case "current":
      return t("settings.plugin.sync.review.recovery_kind.current");
    case "tombstone":
      return t("settings.plugin.sync.review.recovery_kind.tombstone");
    case "deleteEditTombstone":
      return t("settings.plugin.sync.review.recovery_kind.delete_edit_tombstone");
    case "deleteEditCurrent":
      return t("settings.plugin.sync.review.recovery_kind.delete_edit_current");
  }
}

export { ReviewQueueList };
