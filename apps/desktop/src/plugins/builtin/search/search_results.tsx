import { For, Show } from "solid-js";

import type { SimpleSearchHit } from "../core_indexer/types";

interface SearchResultsListProps {
  hits: SimpleSearchHit[];
  onSelect(hit: SimpleSearchHit): void;
  compact?: boolean;
  selectedIndex?: number;
  onHoverIndexChange?: (index: number) => void;
}

function fileNameFromPath(path: string): string {
  return path.split("/").at(-1) ?? path;
}

export function SearchResultsList(props: SearchResultsListProps) {
  const compact = () => props.compact === true;

  return (
    <div class={compact() ? "flex flex-col gap-1" : "flex flex-col gap-2"}>
      <For each={props.hits}>
        {(hit, index) => (
          <button
            type="button"
            class="cursor-pointer rounded-xs border border-border bg-bg-secondary text-left transition-colors"
            classList={{
              "bg-bg-tertiary": props.selectedIndex === index(),
              "px-3 py-2": compact(),
              "p-3 hover:bg-bg-tertiary": !compact(),
            }}
            onMouseEnter={() => props.onHoverIndexChange?.(index())}
            onClick={() => props.onSelect(hit)}
          >
            <div class="flex items-center justify-between gap-3">
              <p
                class={
                  compact()
                    ? "truncate text-sm text-text-primary"
                    : "truncate text-sm font-medium text-text-primary"
                }
              >
                {hit.title ?? fileNameFromPath(hit.docId)}
              </p>
              <span class="shrink-0 text-[0.6875rem] text-text-muted">{hit.kind}</span>
            </div>
            <p class="mt-1 truncate text-xs text-text-muted">{hit.docId}</p>
            <Show when={hit.sectionPath.length > 0}>
              <p class="mt-1 truncate text-[0.6875rem] text-text-muted">
                {hit.sectionPath.join(" / ")}
              </p>
            </Show>
            <p
              class={
                compact()
                  ? "mt-2 text-xs/5 text-text-secondary"
                  : "mt-2 text-xs/5 text-text-secondary"
              }
            >
              {hit.snippet}
            </p>
          </button>
        )}
      </For>
    </div>
  );
}

export { fileNameFromPath };
