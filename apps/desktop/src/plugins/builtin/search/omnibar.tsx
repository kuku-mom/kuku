import { onMount, Show } from "solid-js";

import { closeSearchOmnibar, createOmnibarController } from "./omnibar_state";
import { openSearchHit } from "./navigation";
import { SearchResultsList } from "./search_results";

const INPUT =
  "w-full bg-transparent px-4 py-3 text-sm text-text-primary outline-none placeholder:text-text-muted";

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
      class="pointer-events-auto absolute inset-0 flex items-start justify-center bg-black/20 px-4 py-[10vh]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          closeSearchOmnibar();
        }
      }}
    >
      <div class="w-full max-w-2xl overflow-hidden rounded-md border border-border bg-bg-primary shadow-2xl">
        <div class="border-b border-border">
          <input
            ref={inputRef}
            type="search"
            placeholder="Search your vault"
            class={INPUT}
            value={controller.query()}
            onInput={(event) => controller.scheduleSearch(event.currentTarget.value)}
            onKeyDown={handleKeyDown}
          />
        </div>

        <div class="max-h-[60vh] overflow-auto p-3">
          <Show when={controller.isLoading()}>
            <p class="text-sm text-text-muted">Searching…</p>
          </Show>
          <Show when={!controller.isLoading() && controller.error()}>
            {(error) => <p class="text-sm text-red-400">{error()}</p>}
          </Show>
          <Show when={!controller.isLoading() && !controller.error() && !results()}>
            <p class="text-sm text-text-muted">Type to search indexed markdown content.</p>
          </Show>
          <Show when={!controller.isLoading() && results() && items().length === 0}>
            <p class="text-sm text-text-muted">No matches found.</p>
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
        </div>
      </div>
    </div>
  );
}
