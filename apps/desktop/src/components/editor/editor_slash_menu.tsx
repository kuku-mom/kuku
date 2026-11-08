import { createEffect, createSignal, For, Show } from "solid-js";
import ScrollArea, { type ScrollAreaHandle } from "~/components/scroll_area";
import type { SlashMenuPosition } from "~/components/editor/slash_menu_position";
import { t } from "~/i18n";
import type {
  EditorSlashItem,
  EditorSlashSubItem,
} from "~/plugins/builtin/core_editor/slash_items";

const SUBMENU_WIDTH = 256;
const SUBMENU_GAP = 6;

interface EditorSlashMenuProps {
  position: SlashMenuPosition;
  items: readonly EditorSlashItem[];
  selectedIndex: number;
  isItemDisabled: (item: EditorSlashItem) => boolean;
  /** True when the cursor block already matches this command (e.g. H1 on a level-1 heading). */
  isItemActive?: (item: EditorSlashItem) => boolean;
  onHoverIndexChange: (index: number) => void;
  onSelect: (item: EditorSlashItem) => void;
  submenuOpen?: boolean;
  submenuSelectedIndex?: number;
  submenuUrlInputOpen?: boolean;
  submenuDropzoneOpen?: boolean;
  onSubmenuHoverIndexChange?: (index: number) => void;
  onSubmenuSelect?: (item: EditorSlashItem, subItem: EditorSlashSubItem) => void;
  onSubmenuUrlSubmit?: (item: EditorSlashItem, subItem: EditorSlashSubItem, url: string) => void;
  onSubmenuUrlCancel?: () => void;
  onSubmenuDropFiles?: (
    item: EditorSlashItem,
    subItem: EditorSlashSubItem,
    files: FileList | File[],
  ) => void;
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
  let rootRef: HTMLDivElement | undefined;
  let scrollHandle: ScrollAreaHandle | undefined;
  let urlInputRef: HTMLInputElement | undefined;
  const itemRefs: (HTMLButtonElement | undefined)[] = [];

  const [urlValue, setUrlValue] = createSignal("");
  const [isDragOver, setIsDragOver] = createSignal(false);
  const [submenuTopOffset, setSubmenuTopOffset] = createSignal(0);

  const activeParentItem = (): EditorSlashItem | undefined => {
    const item = props.items[props.selectedIndex];
    if (!item?.submenu || item.submenu.length === 0) return undefined;
    return item;
  };

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

      setSubmenuTopOffset(Math.max(0, itemTop - viewport.scrollTop));
    });
  });

  createEffect(() => {
    if (props.submenuUrlInputOpen) {
      setUrlValue("");
      requestAnimationFrame(() => {
        urlInputRef?.focus();
        urlInputRef?.select();
      });
    }
  });

  const computeSubmenuLeft = (): number => {
    const rightCandidate = props.position.left + props.position.width + SUBMENU_GAP;
    const containerWidth = rootRef?.clientWidth ?? 0;
    if (containerWidth > 0 && rightCandidate + SUBMENU_WIDTH + 8 > containerWidth) {
      return Math.max(8, props.position.left - SUBMENU_WIDTH - SUBMENU_GAP);
    }
    return rightCandidate;
  };

  const computeSubmenuTop = (): number => {
    return props.position.top + submenuTopOffset();
  };

  function submitUrl(parentItem: EditorSlashItem, subItem: EditorSlashSubItem): void {
    const trimmed = urlValue().trim();
    if (!trimmed) return;
    props.onSubmenuUrlSubmit?.(parentItem, subItem, trimmed);
  }

  return (
    <div
      ref={rootRef}
      class="pointer-events-none absolute inset-0 z-50"
      style={{ overflow: "visible" }}
    >
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
                const hasSubmenu = () => Boolean(item.submenu && item.submenu.length > 0);
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
                      <span class="flex shrink-0 items-center gap-1.5 justify-self-end text-xs/normal font-medium text-text-secondary/70">
                        <Show when={hint}>
                          <span>{hint}</span>
                        </Show>
                        <Show when={hasSubmenu()}>
                          <span
                            aria-hidden="true"
                            class="inline-flex items-center text-sm/none text-text-secondary"
                          >
                            →
                          </span>
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

      <Show when={props.submenuOpen && activeParentItem()}>
        {(parentItem) => (
          <div
            class="pointer-events-auto absolute overflow-hidden rounded-none border border-border bg-bg-elevated p-2 [box-shadow:var(--shadow-popover)]"
            style={{
              top: `${computeSubmenuTop()}px`,
              left: `${computeSubmenuLeft()}px`,
              width: `${SUBMENU_WIDTH}px`,
            }}
            onMouseDown={(event) => {
              if (event.target instanceof HTMLInputElement) {
                return;
              }
              event.preventDefault();
            }}
          >
            <div class="flex flex-col gap-0.5 py-0.5">
              <For each={parentItem().submenu ?? []}>
                {(subItem, subIndex) => {
                  const subSelected = () => (props.submenuSelectedIndex ?? 0) === subIndex();
                  const showUrlBox = () =>
                    subItem.kind === "url-input" && subSelected() && props.submenuUrlInputOpen;
                  const isDropzone = () => subItem.kind === "dropzone";

                  return (
                    <div class="flex flex-col">
                      <Show
                        when={!isDropzone()}
                        fallback={
                          <>
                            <div class="mx-1.5 my-2.5 h-px bg-border" />
                            <div
                              title={subItem.description}
                              class="mx-1 mb-1 flex min-h-24 flex-col items-center justify-center gap-1 rounded-none border border-dashed px-4 py-4 text-center transition-colors cursor-pointer"
                              classList={{
                                "border-accent bg-accent-dim/15 text-text-primary":
                                  isDragOver() || subSelected(),
                                "border-border bg-bg-primary/60 text-text-secondary":
                                  !isDragOver() && !subSelected(),
                              }}
                              onMouseEnter={() => props.onSubmenuHoverIndexChange?.(subIndex())}
                              onDragEnter={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                setIsDragOver(true);
                              }}
                              onDragOver={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                setIsDragOver(true);
                              }}
                              onDragLeave={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                setIsDragOver(false);
                              }}
                              onDrop={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                setIsDragOver(false);
                                const files = event.dataTransfer?.files;
                                if (files && files.length > 0) {
                                  props.onSubmenuDropFiles?.(parentItem(), subItem, files);
                                }
                              }}
                              onMouseDown={(event) => {
                                event.preventDefault();
                                props.onSubmenuHoverIndexChange?.(subIndex());
                                if (subItem.execute) {
                                  props.onSubmenuSelect?.(parentItem(), subItem);
                                }
                              }}
                            >
                              <span class="text-xs font-medium text-text-primary">
                                {subItem.title}
                              </span>
                              <span class="text-[0.72rem]/relaxed text-text-secondary">
                                {t("editor.slash.image.dropzone.hint")}
                              </span>
                            </div>
                          </>
                        }
                      >
                        <button
                          type="button"
                          tabIndex={-1}
                          class="grid min-h-8 w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-none px-3 py-1 text-left transition-colors outline-none cursor-pointer"
                          classList={{
                            "bg-ghost-selected": subSelected(),
                          }}
                          title={subItem.description}
                          onMouseEnter={() => props.onSubmenuHoverIndexChange?.(subIndex())}
                          onMouseDown={(event) => {
                            event.preventDefault();
                            props.onSubmenuHoverIndexChange?.(subIndex());
                            props.onSubmenuSelect?.(parentItem(), subItem);
                          }}
                        >
                          <span class="min-w-0">
                            <span class="block truncate text-sm/normal text-text-primary">
                              {subItem.title}
                            </span>
                          </span>
                          <Show when={subItem.hint}>
                            <span class="shrink-0 justify-self-end text-xs/normal font-medium text-text-secondary/70">
                              {subItem.hint}
                            </span>
                          </Show>
                        </button>
                      </Show>

                      <Show when={showUrlBox()}>
                        <div class="mt-1 flex items-center gap-1.5 px-2 pb-1.5 pt-0.5">
                          <input
                            ref={urlInputRef}
                            type="url"
                            value={urlValue()}
                            placeholder={
                              subItem.placeholder ?? t("editor.slash.image.url.placeholder")
                            }
                            class="min-w-0 flex-1 rounded-none border border-border bg-bg-primary px-2 py-1 text-xs text-text-primary outline-none focus:border-accent"
                            onInput={(event) => setUrlValue(event.currentTarget.value)}
                            onKeyDown={(event) => {
                              event.stopPropagation();
                              if (event.key === "Enter") {
                                event.preventDefault();
                                submitUrl(parentItem(), subItem);
                              } else if (event.key === "Escape") {
                                event.preventDefault();
                                props.onSubmenuUrlCancel?.();
                              }
                            }}
                          />
                          <button
                            type="button"
                            class="shrink-0 rounded-none border border-border bg-bg-secondary px-2 py-1 text-xs font-medium text-text-primary hover:bg-ghost-selected cursor-pointer"
                            onMouseDown={(event) => {
                              event.preventDefault();
                              submitUrl(parentItem(), subItem);
                            }}
                          >
                            {t("editor.slash.image.url.submit")}
                          </button>
                        </div>
                      </Show>
                    </div>
                  );
                }}
              </For>
            </div>
          </div>
        )}
      </Show>
    </div>
  );
}
