import { createEffect, For, Show } from "solid-js";

import ScrollArea, { type ScrollAreaHandle } from "~/components/scroll_area";
import type { SlashMenuPosition } from "~/components/editor/slash_menu_position";
import type { WikilinkSuggestItem } from "~/plugins/builtin/wikilink/wikilink_suggest";

interface EditorWikilinkMenuProps {
  position: SlashMenuPosition;
  items: readonly WikilinkSuggestItem[];
  query: string;
  selectedIndex: number;
  onHoverIndexChange: (index: number) => void;
  onSelect: (item: WikilinkSuggestItem) => void;
}

/**
 * Highlight the first occurrence of `query` within `text` by wrapping it
 * in a <mark> element. Returns the original text when there is no match.
 */
function highlightMatch(text: string, query: string) {
  if (!query) return text;

  const lower = text.toLowerCase();
  const idx = lower.indexOf(query.toLowerCase());
  if (idx === -1) return text;

  const before = text.slice(0, idx);
  const match = text.slice(idx, idx + query.length);
  const after = text.slice(idx + query.length);

  return (
    <>
      {before}
      <mark class="bg-transparent font-semibold text-current">{match}</mark>
      {after}
    </>
  );
}

export default function EditorWikilinkMenu(props: EditorWikilinkMenuProps) {
  let scrollHandle: ScrollAreaHandle | undefined;
  const itemRefs: (HTMLButtonElement | undefined)[] = [];

  // Keep the refs array in sync with the items length.
  createEffect(() => {
    itemRefs.length = props.items.length;
  });

  // Auto-scroll the selected item into view.
  createEffect(() => {
    const selectedIndex = props.selectedIndex;
    if (selectedIndex < 0 || selectedIndex >= props.items.length) return;

    requestAnimationFrame(() => {
      const viewport = scrollHandle?.viewport;
      const item = itemRefs[selectedIndex];
      if (!viewport || !item) return;

      const itemTop = item.offsetTop;
      const itemBottom = itemTop + item.offsetHeight;
      const viewportTop = viewport.scrollTop;
      const viewportBottom = viewportTop + viewport.clientHeight;

      if (itemTop < viewportTop) {
        viewport.scrollTop = Math.max(0, itemTop - 4);
      } else if (itemBottom > viewportBottom) {
        viewport.scrollTop = itemBottom - viewport.clientHeight + 4;
      }
    });
  });

  return (
    <div class="pointer-events-none absolute inset-0 z-50" style={{ overflow: "visible" }}>
      <div
        class="pointer-events-auto absolute overflow-hidden rounded-none border border-border bg-bg-elevated p-2 [box-shadow:var(--shadow-popover)]"
        style={{
          top: `${props.position.top}px`,
          left: `${props.position.left}px`,
          width: `${props.position.width}px`,
        }}
        onMouseDown={(event) => {
          event.preventDefault();
        }}
      >
        <Show
          when={props.items.length > 0}
          fallback={
            <div class="px-3 py-2.5 text-[0.8125rem] text-text-muted">
              {props.query ? "No matching notes." : "No notes in vault."}
            </div>
          }
        >
          <ScrollArea
            axis="y"
            class="py-0.5"
            handleRef={(handle) => {
              scrollHandle = handle;
            }}
            style={{ "max-height": `${props.position.maxHeight}px` }}
          >
            <For each={props.items}>
              {(item, index) => {
                const selected = () => props.selectedIndex === index();

                return (
                  <button
                    ref={(el) => {
                      itemRefs[index()] = el;
                    }}
                    type="button"
                    tabIndex={-1}
                    class="grid min-h-8 w-full cursor-pointer grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-2.5 rounded-none px-3 py-1.5 text-left transition-colors outline-none"
                    classList={{
                      "bg-ghost-selected": selected(),
                    }}
                    onMouseEnter={() => props.onHoverIndexChange(index())}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      props.onSelect(item);
                    }}
                  >
                    <span class="flex size-5 shrink-0 items-center justify-center text-text-muted">
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.5"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      >
                        <path d="M9 2H4.5A1.5 1.5 0 0 0 3 3.5v9A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5V6L9 2Z" />
                        <path d="M9 2v4h4" />
                      </svg>
                    </span>
                    <span class="min-w-0 truncate">
                      <span class="text-[0.8125rem] leading-normal font-medium text-text-primary">
                        {highlightMatch(item.name, props.query)}
                      </span>
                    </span>
                    <Show when={item.folder}>
                      {(folder) => (
                        <span class="max-w-32 truncate text-xs/normal font-medium text-text-secondary/70">
                          {folder()}
                        </span>
                      )}
                    </Show>
                  </button>
                );
              }}
            </For>
          </ScrollArea>
        </Show>
      </div>
    </div>
  );
}
