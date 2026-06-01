import { onMount, Show } from "solid-js";

import ScrollArea from "~/components/scroll_area";
import { t } from "~/i18n";

import { closeSearchOmnibar, createOmnibarController } from "./omnibar_state";
import { openSearchHit } from "./navigation";
import { SearchResultsList } from "./search_results";

const INPUT =
  "min-w-0 flex-1 bg-transparent px-2 py-2 text-sm text-text-primary outline-none placeholder:text-text-muted";
const MODE_TOGGLE =
  "h-7 shrink-0 cursor-pointer whitespace-nowrap rounded-xs border border-border px-2 text-xs transition-colors hover:bg-ghost-hover";
const CASE_TOGGLE =
  "h-7 shrink-0 cursor-pointer whitespace-nowrap rounded-xs border border-border px-2 text-xs transition-colors hover:bg-ghost-hover";

export default function SearchOmnibar() {
  const controller = createOmnibarController();
  const results = () => controller.results();
  const items = () => results()?.items ?? [];
  let inputRef: HTMLInputElement | undefined;

  const submitSelection = () => {
    const hit = controller.selectCurrent();
    if (!hit) return;
    closeSearchOmnibar();
    openSearchHit(hit);
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    switch (event.key) {
      case "Escape":
        event.preventDefault();
        closeSearchOmnibar();
        break;
      case "ArrowDown":
        event.preventDefault();
        controller.moveSelection(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        controller.moveSelection(-1);
        break;
      case "Enter":
        event.preventDefault();
        submitSelection();
        break;
    }
  };

  onMount(() => {
    inputRef?.focus();
  });

  return (
    <div
      class="pointer-events-auto absolute inset-0 flex items-start justify-center bg-black/40 px-4 py-[10vh] backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          closeSearchOmnibar();
        }
      }}
    >
      <div class="w-full max-w-2xl overflow-hidden rounded-xs border border-border bg-bg-elevated shadow-popover">
        <div class="flex items-center gap-2 border-b border-border p-2">
          <input
            ref={inputRef}
            type="search"
            placeholder={t("search.placeholder")}
            class={INPUT}
            value={controller.query()}
            onInput={(event) => controller.scheduleSearch(event.currentTarget.value)}
            onKeyDown={handleKeyDown}
          />
          <button
            type="button"
            data-kuku-search-mode-toggle="true"
            aria-pressed={controller.mode() === "regex"}
            title={
              controller.mode() === "regex" ? t("search.mode.simple") : t("search.mode.advanced")
            }
            class={`${MODE_TOGGLE} ${
              controller.mode() === "regex"
                ? "bg-bg-primary text-text-primary"
                : "bg-transparent text-text-muted"
            }`}
            onClick={() =>
              controller.setMode(controller.mode() === "regex" ? "simple" : "regex")
            }
          >
            {t("search.mode.advanced")}
          </button>
          <Show when={controller.mode() === "regex"}>
            <button
              type="button"
              data-kuku-search-case-sensitive-toggle="true"
              aria-pressed={controller.caseSensitive()}
              class={`${CASE_TOGGLE} ${
                controller.caseSensitive()
                  ? "bg-bg-primary text-text-primary"
                  : "bg-transparent text-text-muted"
              }`}
              onClick={() => controller.setCaseSensitive(!controller.caseSensitive())}
            >
              {t("search.option.case_sensitive")}
            </button>
          </Show>
        </div>

        <ScrollArea class="max-h-[60vh] p-3">
          <Show when={controller.isLoading()}>
            <p class="text-sm text-text-muted">{t("search.loading")}</p>
          </Show>
          <Show when={!controller.isLoading() && controller.error()}>
            {(error) => <p class="text-sm text-error">{error()}</p>}
          </Show>
          <Show when={!controller.isLoading() && !controller.error() && !results()}>
            <p class="text-sm text-text-muted">{t("search.empty.before_query")}</p>
          </Show>
          <Show when={!controller.isLoading() && results() && items().length === 0}>
            <p class="text-sm text-text-muted">{t("search.empty.no_match")}</p>
          </Show>
          <Show when={items().length > 0}>
            <SearchResultsList
              hits={items()}
              compact
              selectedIndex={controller.selectedIndex()}
              onHoverIndexChange={(index) => controller.setSelectedIndex(index)}
              onSelect={(hit) => {
                closeSearchOmnibar();
                openSearchHit(hit);
              }}
            />
          </Show>
        </ScrollArea>
      </div>
    </div>
  );
}
