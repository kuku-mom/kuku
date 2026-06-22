import { For, Show, createEffect, createMemo, createSignal, onCleanup, type JSX } from "solid-js";

import { t } from "~/i18n";
import { vaultState } from "~/stores/vault";

import { chatState, switchScope } from "../chat_store";
import { getFolderScopeOptions, scopeTitle } from "../folder_scope";

function FolderScopeSelector(props: { disabled?: boolean }): JSX.Element {
  let rootRef: HTMLDivElement | undefined;
  const [open, setOpen] = createSignal(false);
  const options = createMemo(() => getFolderScopeOptions(vaultState.files));

  createEffect(() => {
    if (!open()) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (rootRef && target instanceof Node && !rootRef.contains(target)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    onCleanup(() => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    });
  });

  return (
    <div class="relative min-w-0" ref={(el) => (rootRef = el)}>
      <button
        type="button"
        disabled={props.disabled}
        class="inline-flex min-h-7 max-w-36 items-center gap-1 rounded-sm px-1.5 py-1 text-[0.8125rem] font-medium text-text-secondary transition hover:bg-ghost-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50 sm:max-w-44"
        title={t("chat.scope.select")}
        onClick={() => setOpen(!open())}
      >
        <span class="truncate">{scopeTitle(chatState.selectedScope)}</span>
        <svg
          class="shrink-0 translate-y-px text-text-muted"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          aria-hidden="true"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      <Show when={open()}>
        <div class="absolute bottom-full left-0 z-50 mb-1.5 w-[min(100vw-1rem,18rem)] min-w-[16rem] overflow-hidden rounded-sm border border-border bg-bg-elevated py-1">
          <button
            type="button"
            class="flex w-full items-center justify-between gap-2 px-2.5 py-2 text-left transition hover:bg-ghost-hover"
            classList={{ "bg-ghost-hover": chatState.selectedScope.kind === "vault" }}
            onClick={() => {
              switchScope({ kind: "vault" });
              setOpen(false);
            }}
          >
            <span class="truncate text-[0.8125rem] font-medium text-text-primary">
              {t("chat.scope.vault")}
            </span>
            <span class="text-[0.6875rem] text-text-muted">{t("chat.scope.vault_hint")}</span>
          </button>

          <Show
            when={options().length > 0}
            fallback={
              <p class="px-2.5 py-2 text-[0.75rem] text-text-muted">
                {t("chat.scope.no_folders")}
              </p>
            }
          >
            <div class="my-1 h-px bg-border/60" />
            <For each={options()}>
              {(option) => {
                const selected = () =>
                  chatState.selectedScope.kind === "folder" &&
                  chatState.selectedScope.folder === option.folder;
                const isReady = () => option.missingFiles.length === 0;
                return (
                  <button
                    type="button"
                    class="flex w-full items-center justify-between gap-2 px-2.5 py-2 text-left transition hover:bg-ghost-hover"
                    classList={{ "bg-ghost-hover": selected() }}
                    onClick={() => {
                      switchScope({ kind: "folder", folder: option.folder });
                      setOpen(false);
                    }}
                  >
                    <span class="min-w-0">
                      <span class="block truncate text-[0.8125rem] font-medium text-text-primary">
                        {option.label}
                      </span>
                      <span class="block truncate text-[0.6875rem] text-text-muted">
                        {isReady()
                          ? t("chat.scope.folder_ready")
                          : t("chat.scope.folder_missing_setup")}
                      </span>
                    </span>
                    <span
                      class="size-1.5 shrink-0 rounded-full"
                      classList={{
                        "bg-success": isReady(),
                        "bg-warning": !isReady(),
                      }}
                      aria-hidden="true"
                    />
                  </button>
                );
              }}
            </For>
          </Show>
        </div>
      </Show>
    </div>
  );
}

export { FolderScopeSelector };
