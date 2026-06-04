import { createEffect, For, Show } from "solid-js";
import ScrollArea, { type ScrollAreaHandle } from "~/components/scroll_area";
import type { SlashMenuPosition } from "~/components/editor/slash_menu_position";
import { t } from "~/i18n";
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

function renderSlashItemHint(item: EditorSlashItem): string {
  switch (item.icon) {
    case "heading1":
      return "#";
    case "heading2":
      return "##";
    case "heading3":
      return "###";
    case "blockquote":
      return ">";
    case "codeBlock":
      return "```";
    case "horizontalRule":
      return "---";
    case "image":
      return "/i";
    case "table":
      return "/t";
    case "bulletList":
      return "-";
    case "orderedList":
      return "1.";
    case "taskList":
      return "[]";
    default:
      return item.keywords?.[0] ? `/${item.keywords[0]}` : "";
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
              {t("editor.slash.empty")}
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
                const disabled = () => props.isItemDisabled(item);
                const active = () => props.isItemActive?.(item) === true;
                const selected = () => props.selectedIndex === index();
                const showSeparator = () =>
                  index() > 0 && props.items[index() - 1]?.group !== item.group;
                const hint = renderSlashItemHint(item);

                return (
                  <>
                    <Show when={showSeparator()}>
                      <div class="mx-1.5 my-1 h-px bg-border" />
                    </Show>
                    <button
                      ref={(el) => {
                        itemRefs[index()] = el;
                      }}
                      type="button"
                      tabIndex={-1}
                      class="grid min-h-8 w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-none px-3 py-1 text-left transition-colors outline-none"
                      classList={{
                        "bg-accent-dim/15": active() && !selected(),
                        "bg-ghost-selected": selected() && !disabled(),
                        "cursor-pointer": !disabled(),
                        "cursor-not-allowed opacity-50": disabled(),
                      }}
                      title={item.description}
                      disabled={disabled()}
                      onMouseEnter={() => props.onHoverIndexChange(index())}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        if (!disabled()) {
                          props.onSelect(item);
                        }
                      }}
                    >
                      <span class="min-w-0">
                        <span class="block truncate text-base/normal text-text-primary">
                          {item.title}
                        </span>
                      </span>
                      <Show when={hint}>
                        <span class="shrink-0 justify-self-end text-xs/normal font-medium text-text-secondary/70">
                          {hint}
                        </span>
                      </Show>
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
