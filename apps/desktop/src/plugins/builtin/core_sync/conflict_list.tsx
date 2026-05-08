import { For, Show, createSignal, type JSX } from "solid-js";

import { FileIcon } from "~/components/icons";
import { SettingsBanner, SettingsListRow } from "~/components/settings/settings_blocks";
import { t } from "~/i18n";
import { vaultExists } from "~/lib/vault_fs";
import { openTab } from "~/stores/files";

import { syncConflicts } from "./status_store";
import type { SyncConflictSummary } from "./types";

function formatTimestamp(ms: number): string {
  if (!ms) return "";
  return new Date(ms).toLocaleString();
}

function fileNameFromPath(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

interface ConflictListProps {
  disabled?: boolean;
}

function ConflictList(props: ConflictListProps = {}): JSX.Element {
  const [localError, setLocalError] = createSignal<string | null>(null);

  async function openConflictCopy(conflict: SyncConflictSummary): Promise<void> {
    if (props.disabled) return;
    setLocalError(null);
    try {
      if (!(await vaultExists(conflict.conflictPath))) {
        setLocalError(t("settings.plugin.sync.conflicts.missing"));
        return;
      }
      openTab(fileNameFromPath(conflict.conflictPath), conflict.conflictPath, "editor");
    } catch {
      setLocalError(t("settings.plugin.sync.conflicts.open_failed"));
    }
  }

  return (
    <div class="space-y-2">
      <Show when={localError()}>
        {(message) => <SettingsBanner tone="error" description={message()} />}
      </Show>
      <Show
        when={syncConflicts.length > 0}
        fallback={
          <SettingsBanner tone="success" description={t("settings.plugin.sync.conflicts.empty")} />
        }
      >
        <div class="space-y-2">
          <For each={syncConflicts}>
            {(conflict) => (
              <SettingsListRow
                title={<span class="break-all">{conflict.path}</span>}
                description={
                  <span class="break-all">
                    {t("settings.plugin.sync.conflicts.copy_prefix")} {conflict.conflictPath}
                  </span>
                }
                action={
                  <div class="flex items-center gap-2">
                    <span class="text-[0.6875rem] whitespace-nowrap text-text-muted">
                      {formatTimestamp(conflict.createdAtMs)}
                    </span>
                    <button
                      type="button"
                      class={[
                        "inline-flex size-6 items-center justify-center rounded-xs border border-border bg-bg-secondary text-text-muted transition-colors",
                        props.disabled
                          ? "cursor-not-allowed opacity-50"
                          : "cursor-pointer hover:bg-bg-tertiary hover:text-text-primary",
                      ].join(" ")}
                      disabled={props.disabled}
                      title={t("settings.plugin.sync.conflicts.open_copy")}
                      aria-label={t("settings.plugin.sync.conflicts.open_copy")}
                      onClick={() => void openConflictCopy(conflict)}
                    >
                      <FileIcon size={13} />
                    </button>
                  </div>
                }
              />
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

export { ConflictList };
