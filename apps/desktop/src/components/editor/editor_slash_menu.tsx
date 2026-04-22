import { createEffect, For, Show, type JSX } from "solid-js";

import {
  CodeIcon,
  Heading1Icon,
  Heading2Icon,
  Heading3Icon,
  ListIcon,
  ListOrderedIcon,
  QuoteIcon,
} from "~/components/icons";
import ScrollArea, { type ScrollAreaHandle } from "~/components/scroll_area";
import type { SlashMenuPosition } from "~/components/editor/slash_menu_position";
import type { EditorSlashItem } from "~/plugins/builtin/core_editor/slash_items";

interface EditorSlashMenuProps {
  position: SlashMenuPosition;
  items: readonly EditorSlashItem[];
  selectedIndex: number;
  isItemDisabled: (item: EditorSlashItem) => boolean;
  /** True when the cursor block already matches this command (e.g. H1 on a level-1 heading). */
  isItemActive?: (item: EditorSlashItem) => boolean;
  onHoverIndexChange: (index: number) => void;
  onSelect: (item: EditorSlashItem) => void;
}

function renderSlashItemIcon(item: EditorSlashItem): JSX.Element {
  switch (item.icon) {
    case "heading1":
      return <Heading1Icon size={14} />;
    case "heading2":
      return <Heading2Icon size={14} />;
    case "heading3":
      return <Heading3Icon size={14} />;
    case "blockquote":
      return <QuoteIcon size={14} />;
    case "codeBlock":
      return <CodeIcon size={14} />;
    case "bulletList":
      return <ListIcon size={14} />;
    case "orderedList":
      return <ListOrderedIcon size={14} />;
    case "taskList":
      return <span class="text-[0.625rem] leading-none font-medium">[]</span>;
    default:
      return (
        <span class="text-[0.625rem] leading-none font-medium">
          {item.title.slice(0, 2).toUpperCase()}
        </span>
      );
  }
}

export default function EditorSlashMenu(props: EditorSlashMenuProps) {
  let scrollHandle: ScrollAreaHandle | undefined;
  const itemRefs: (HTMLButtonElement | undefined)[] = [];

  createEffect(() => {
    const nextLength = props.items.length;
    itemRefs.length = nextLength;
  });

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
        class="pointer-events-auto absolute overflow-hidden rounded-sm border border-border bg-bg-elevated [box-shadow:var(--shadow-command-bubble)]"
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
          fallback={<div class="p-3 text-[0.8125rem] text-text-muted">No matching commands.</div>}
        >
          <ScrollArea
            axis="y"
            class="py-1"
            handleRef={(handle) => {
              scrollHandle = handle;
            }}
            style={{ "max-height": `${props.position.maxHeight}px` }}
          >
            <For each={props.items}>
              {(item, index) => {
                const disabled = () => props.isItemDisabled(item);
                const active = () => props.isItemActive?.(item) === true;
                const selected = () => props.selectedIndex === index();
                const showSeparator = () =>
                  index() > 0 && props.items[index() - 1]?.group !== item.group;

                return (
                  <>
                    <Show when={showSeparator()}>
                      <div class="mx-2 my-1 h-px bg-border" />
                    </Show>
                    <button
                      ref={(el) => {
                        itemRefs[index()] = el;
                      }}
                      type="button"
                      tabIndex={-1}
                      class="flex w-full items-start gap-3 border-l-2 border-l-transparent py-2 pr-3 pl-[calc(0.75rem+2px)] text-left transition-colors outline-none"
                      classList={{
                        "border-l-accent/50 bg-accent-dim/15": active(),
                        "bg-ghost-hover": selected() && !disabled(),
                        "cursor-pointer": !disabled(),
                        "cursor-not-allowed opacity-50": disabled(),
                      }}
                      disabled={disabled()}
                      onMouseEnter={() => props.onHoverIndexChange(index())}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        if (!disabled()) {
                          props.onSelect(item);
                        }
                      }}
                    >
                      <span class="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-xs border border-border bg-bg-primary text-text-secondary">
                        {renderSlashItemIcon(item)}
                      </span>
                      <span class="min-w-0 flex-1">
                        <span class="block text-[0.8125rem] text-text-primary">{item.title}</span>
                        <Show when={item.description}>
                          {(description) => (
                            <span class="mt-0.5 block text-xs/snug text-text-muted">
                              {description()}
                            </span>
                          )}
                        </Show>
                      </span>
                    </button>
                  </>
                );
              }}
            </For>
          </ScrollArea>
        </Show>
      </div>
    </div>
  );
}
