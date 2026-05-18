import { onCleanup, onMount, Show } from "solid-js";

import { CloseIcon } from "~/components/icons";
import SettingsView from "~/components/settings/settings_view";
import { t } from "~/i18n";
import { closeSettings, filesState } from "~/stores/files";

function SettingsDialog() {
  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      closeSettings();
    }
  }

  onMount(() => window.addEventListener("keydown", onKeyDown));
  onCleanup(() => window.removeEventListener("keydown", onKeyDown));

  return (
    <Show when={filesState.settingsDialogOpen}>
      <div
        class="fixed inset-0 z-40 flex items-center justify-center bg-black/55 p-5"
        role="dialog"
        aria-modal="true"
        aria-label={t("settings.dialog.title")}
        onClick={() => closeSettings()}
      >
        <div
          class="flex h-[min(46rem,calc(100vh-3rem))] w-[min(58rem,calc(100vw-3rem))] min-w-0 flex-col overflow-hidden rounded-md border border-border bg-bg-primary shadow-2xl"
          onClick={(event) => event.stopPropagation()}
        >
          <header class="flex h-11 shrink-0 items-center justify-between border-b border-border bg-bg-secondary px-4">
            <h2 class="text-sm font-medium text-text-primary">{t("settings.dialog.title")}</h2>
            <button
              type="button"
              class="flex size-7 items-center justify-center rounded-md text-icon-muted transition hover:bg-ghost-hover hover:text-icon"
              title={t("settings.dialog.close")}
              aria-label={t("settings.dialog.close")}
              onClick={() => closeSettings()}
            >
              <CloseIcon size={13} />
            </button>
          </header>
          <div class="min-h-0 flex-1">
            <SettingsView />
          </div>
        </div>
      </div>
    </Show>
  );
}

export default SettingsDialog;
