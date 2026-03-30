import { Show } from "solid-js";

import ScrollArea from "~/components/scroll_area";

import { indexerStatus } from "../core_indexer/status_store";
import { openSearchHit } from "./navigation";
import { SearchResultsList } from "./search_results";
import { createSearchTabController } from "./search_tab_state";

const INPUT =
  "w-full rounded-xs border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary outline-none transition-colors focus:border-accent";

export default function SearchTab() {
  const controller = createSearchTabController();
  const searchResults = () => controller.results();
  const items = () => searchResults()?.items ?? [];

  return (
    <div class="flex h-full min-h-0 flex-col bg-bg-primary">
      <div class="border-b border-border px-2 pb-2">
        <div class="mt-3 flex items-center gap-3">
          <input
            type="search"
            placeholder="Search your vault"
            class={INPUT}
            value={controller.query()}
            onInput={(event) => controller.scheduleSearch(event.currentTarget.value)}
          />
        </div>

        <div class="mt-2 flex items-center justify-between text-xs text-text-muted">
          <span>
            Status: {indexerStatus.state} ({indexerStatus.indexedDocs}/{indexerStatus.totalDocs})
          </span>
          <Show when={controller.results()}>
            {(results) => <span>{results().total} result(s)</span>}
          </Show>
        </div>
        <Show when={indexerStatus.error}>
          {(error) => <p class="mt-1 text-xs text-error">{error()}</p>}
        </Show>
      </div>

      <ScrollArea class="min-h-0 flex-1 px-4 py-3">
        <Show when={controller.isLoading()}>
          <p class="text-sm text-text-muted">Searching…</p>
        </Show>
        <Show when={!controller.isLoading() && controller.error()}>
          {(error) => <p class="text-sm text-error">{error()}</p>}
        </Show>
        <Show when={!controller.isLoading() && !controller.error() && !searchResults()}>
          <p class="text-sm text-text-muted">Type to search indexed markdown content.</p>
        </Show>
        <Show when={!controller.isLoading() && searchResults() && items().length === 0}>
          <p class="text-sm text-text-muted">No matches found.</p>
        </Show>
        <Show when={items().length > 0}>
          <SearchResultsList hits={items()} onSelect={openSearchHit} />
        </Show>
      </ScrollArea>
    </div>
  );
}
