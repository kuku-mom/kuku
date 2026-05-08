import { For, Show, type JSX } from "solid-js";

import { SettingsBanner, SettingsListRow } from "~/components/settings/settings_blocks";
import { t } from "~/i18n";

import { syncConflicts } from "./status_store";

function formatTimestamp(ms: number): string {
  if (!ms) return "";
  return new Date(ms).toLocaleString();
}

function ConflictList(): JSX.Element {
  return (
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
                <span class="text-[0.6875rem] whitespace-nowrap text-text-muted">
                  {formatTimestamp(conflict.createdAtMs)}
                </span>
              }
            />
          )}
        </For>
      </div>
    </Show>
  );
}

export { ConflictList };
