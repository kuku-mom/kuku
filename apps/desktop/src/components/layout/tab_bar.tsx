import {
  batch,
  createEffect,
  createSignal,
  For,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
} from "solid-js";

import {
  CloseIcon,
  EllipsisVerticalIcon,
  FileIcon,
  GraphIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
} from "~/components/icons";
import ScrollArea, { type ScrollAreaHandle } from "~/components/scroll_area";
import { t } from "~/i18n";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui";
import { executePluginCommand, isPluginCommandVisible } from "~/plugins/commands";
import { getTabBarMoreActionIds } from "~/components/layout/tab_bar_actions";
import { closeTab, filesState, openTab, reorderTabs, setActiveTab } from "~/stores/files";
import {
  cancelEdit,
  confirmEdit,
  createAndOpenNewFile,
  startRename,
  updateEditName,
  vaultState,
  type EditState,
} from "~/stores/vault";

// NOTE: The following CSS rules live in scrollbar.css (ScrollArea content DOM we don't style inline):
//   .tab-bar .os-scrollbar-horizontal { top: 0; bottom: auto; }
//   .tab-bar-tabs [data-scroll-area-content] { display:flex; align-items:center; padding:0 2px; }

// ── Helpers ──

function stripExtension(name: string): string {
  const dotIndex = name.lastIndexOf(".");
  return dotIndex > 0 ? name.substring(0, dotIndex) : name;
}

// ── Styles ──

const ACTION_BTN =
  "flex size-[26px] cursor-pointer items-center justify-center rounded-xs border-none bg-transparent text-icon-muted transition-all duration-100 hover:bg-ghost-hover hover:text-icon data-[expanded]:bg-ghost-hover data-[expanded]:text-icon";

// ── Component ──

function TabRenameInput(props: { editState: EditState }) {
  let inputRef: HTMLInputElement | undefined;

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void confirmEdit();
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      cancelEdit();
    }
  };

  onMount(() => {
    inputRef?.focus();
    inputRef?.select();
  });

  return (
    <input
      ref={inputRef}
      class="min-w-0 flex-1 rounded-xs border border-accent bg-bg-primary p-1 text-[0.8125rem] leading-none text-text-primary outline-none"
      value={props.editState.name}
      onInput={(event) => updateEditName(event.currentTarget.value)}
      onKeyDown={handleKeyDown}
      onBlur={() => void confirmEdit()}
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onDblClick={(event) => event.stopPropagation()}
    />
  );
}

export default function TabBar() {
  const moreActionIds = getTabBarMoreActionIds();

  let scrollHandle: ScrollAreaHandle | undefined;

  const getViewport = () => scrollHandle?.viewport;

  // ── Scroll active tab into view with minimal movement ──

  const PEEK_OFFSET = 48;

  function scrollActiveTabIntoView() {
    const activeId = filesState.activeTabId;
    if (!activeId) return;
    requestAnimationFrame(() => {
      const viewport = getViewport();
      if (!viewport) return;
      const el = viewport.querySelector<HTMLElement>(`[data-tab-id="${activeId}"]`);
      if (!el) return;

      const containerLeft = viewport.scrollLeft;
      const containerRight = containerLeft + viewport.clientWidth;
      const elLeft = el.offsetLeft;
      const elRight = elLeft + el.offsetWidth;

      // Only scroll when the tab is outside (or nearly outside) the visible area.
      // This gives us VSCode-style "minimum movement" behaviour.
      if (elRight + PEEK_OFFSET > containerRight) {
        viewport.scrollLeft = elRight + PEEK_OFFSET - viewport.clientWidth;
      } else if (elLeft - PEEK_OFFSET < containerLeft) {
        viewport.scrollLeft = Math.max(0, elLeft - PEEK_OFFSET);
      }
    });
  }

  createEffect(() => {
    // Re-runs whenever activeTabId changes.
    scrollActiveTabIntoView();
  });

  // ── Drag-to-reorder (mirrors file-browser drag UX) ──

  const DRAG_THRESHOLD_PX = 4;
  const EDGE_AUTOSCROLL_ZONE = 40;
  const EDGE_AUTOSCROLL_MAX_SPEED = 14;

  const [draggingTabId, setDraggingTabId] = createSignal<string | null>(null);
  const [dropIndex, setDropIndex] = createSignal<number | null>(null);
  const [dragPointer, setDragPointer] = createSignal({ x: 0, y: 0 });
  let pendingDragStart: { tabId: string; startX: number; startY: number } | null = null;
  let suppressClicksUntil = 0;
  let autoScrollRaf = 0;
  let autoScrollDelta = 0;

  const shouldSuppressClick = () => Date.now() < suppressClicksUntil;
  const suppressClicksBriefly = () => {
    suppressClicksUntil = Date.now() + 250;
  };

  const draggingFileName = () => {
    const id = draggingTabId();
    if (!id) return null;
    return filesState.tabs.find((tab) => tab.id === id)?.fileName ?? null;
  };

  const computeDropIndex = (clientX: number): number => {
    const viewport = getViewport();
    if (!viewport) return filesState.tabs.length;
    const tabEls = viewport.querySelectorAll<HTMLElement>("[data-tab-id]");
    for (let i = 0; i < tabEls.length; i += 1) {
      const rect = tabEls[i].getBoundingClientRect();
      if (clientX < rect.left + rect.width / 2) return i;
    }
    return tabEls.length;
  };

  const stopAutoScroll = () => {
    autoScrollDelta = 0;
    if (autoScrollRaf) {
      cancelAnimationFrame(autoScrollRaf);
      autoScrollRaf = 0;
    }
  };

  // Runs while the drag pointer sits in a horizontal edge zone. Re-schedules
  // itself every frame so the scroll keeps going even when the mouse stops
  // moving (standard DnD auto-scroll behaviour).
  const autoScrollStep = () => {
    const viewport = getViewport();
    if (!viewport || autoScrollDelta === 0) {
      autoScrollRaf = 0;
      return;
    }
    viewport.scrollLeft += autoScrollDelta;
    setDropIndex(computeDropIndex(dragPointer().x));
    autoScrollRaf = requestAnimationFrame(autoScrollStep);
  };

  const updateAutoScroll = (clientX: number) => {
    const viewport = getViewport();
    if (!viewport) {
      stopAutoScroll();
      return;
    }
    const rect = viewport.getBoundingClientRect();
    let delta = 0;
    if (clientX < rect.left + EDGE_AUTOSCROLL_ZONE) {
      const ratio = (rect.left + EDGE_AUTOSCROLL_ZONE - clientX) / EDGE_AUTOSCROLL_ZONE;
      delta = -Math.max(2, Math.min(EDGE_AUTOSCROLL_MAX_SPEED, ratio * EDGE_AUTOSCROLL_MAX_SPEED));
    } else if (clientX > rect.right - EDGE_AUTOSCROLL_ZONE) {
      const ratio = (clientX - (rect.right - EDGE_AUTOSCROLL_ZONE)) / EDGE_AUTOSCROLL_ZONE;
      delta = Math.max(2, Math.min(EDGE_AUTOSCROLL_MAX_SPEED, ratio * EDGE_AUTOSCROLL_MAX_SPEED));
    }
    autoScrollDelta = delta;
    if (delta !== 0 && !autoScrollRaf) {
      autoScrollRaf = requestAnimationFrame(autoScrollStep);
    } else if (delta === 0) {
      stopAutoScroll();
    }
  };

  const clearDragState = () => {
    pendingDragStart = null;
    stopAutoScroll();
    batch(() => {
      setDraggingTabId(null);
      setDropIndex(null);
    });
  };

  const handleDocumentMouseMove = (event: MouseEvent) => {
    if (!pendingDragStart && !draggingTabId()) return;

    if (!draggingTabId()) {
      const pending = pendingDragStart;
      if (!pending) return;
      const dx = event.clientX - pending.startX;
      const dy = event.clientY - pending.startY;
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;

      batch(() => {
        setDraggingTabId(pending.tabId);
        setDragPointer({ x: event.clientX, y: event.clientY });
        setDropIndex(computeDropIndex(event.clientX));
      });
      suppressClicksBriefly();
      pendingDragStart = null;
      event.preventDefault();
      return;
    }

    batch(() => {
      setDragPointer({ x: event.clientX, y: event.clientY });
      setDropIndex(computeDropIndex(event.clientX));
    });
    updateAutoScroll(event.clientX);
    event.preventDefault();
  };

  const handleDocumentMouseUp = (event: MouseEvent) => {
    const draggedId = draggingTabId();
    if (!draggedId) {
      pendingDragStart = null;
      return;
    }

    const fromIndex = filesState.tabs.findIndex((tab) => tab.id === draggedId);
    let target = dropIndex() ?? fromIndex;
    // The drop index is computed on the pre-splice array. When the dragged
    // tab ends up after its original slot we subtract one to account for
    // the splice that removes it first.
    if (target > fromIndex) target -= 1;

    clearDragState();
    suppressClicksBriefly();
    event.preventDefault();

    if (fromIndex === -1 || target === fromIndex) return;
    reorderTabs(fromIndex, target);
  };

  const handleWindowBlur = () => {
    clearDragState();
  };

  onMount(() => {
    window.addEventListener("mousemove", handleDocumentMouseMove, true);
    window.addEventListener("mouseup", handleDocumentMouseUp, true);
    window.addEventListener("blur", handleWindowBlur);
  });

  onCleanup(() => {
    window.removeEventListener("mousemove", handleDocumentMouseMove, true);
    window.removeEventListener("mouseup", handleDocumentMouseUp, true);
    window.removeEventListener("blur", handleWindowBlur);
    clearDragState();
  });

  // ── Tab interaction handlers ──

  const handleTabMouseDown = (tabId: string, e: MouseEvent) => {
    if (e.button === 1) {
      e.preventDefault();
      closeTab(tabId);
      return;
    }
    if (e.button !== 0) return;
    // Don't initiate a drag while a tab rename input is active — the tab's
    // label becomes an <input>, and starting a drag would yank it out.
    const editing = vaultState.editState;
    if (editing?.kind === "rename" && editing.surface === "tab") return;

    pendingDragStart = { tabId, startX: e.clientX, startY: e.clientY };
  };

  const handleTabClick = (tabId: string, e: MouseEvent) => {
    if (shouldSuppressClick()) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    setActiveTab(tabId);
  };

  const handleCloseClick = (tabId: string, e: MouseEvent) => {
    e.stopPropagation();
    closeTab(tabId);
  };

  return (
    <div class="tab-bar relative z-10 border-b border-border bg-bg-secondary">
      <div class="flex h-9.5 items-center gap-1 px-2">
        {/* ── Tab list (horizontal scroll with visible scrollbar) ── */}
        <ScrollArea
          class="tab-bar-tabs min-w-0 flex-1"
          axis="x"
          handleRef={(handle) => {
            scrollHandle = handle;
          }}
          horizontalWheel
          scrollbarVisibility="hidden"
        >
          <div class="flex items-center py-1">
            <For each={filesState.tabs}>
              {(tab, index) => {
                const isActive = () => tab.id === filesState.activeTabId;
                const isLast = () => index() === filesState.tabs.length - 1;
                const isDragging = () => draggingTabId() === tab.id;
                const showDropBefore = () =>
                  draggingTabId() !== null && dropIndex() === index() && draggingTabId() !== tab.id;
                const showDropAfter = () =>
                  isLast() &&
                  draggingTabId() !== null &&
                  dropIndex() === filesState.tabs.length &&
                  draggingTabId() !== tab.id;
                const rowEditState = () =>
                  tab.type === "editor" &&
                  tab.filePath &&
                  vaultState.editState?.kind === "rename" &&
                  vaultState.editState.surface === "tab" &&
                  vaultState.editState.targetPath === tab.filePath
                    ? vaultState.editState
                    : null;

                return (
                  <>
                    {/* Drop indicator (before this tab) */}
                    <Show when={showDropBefore()}>
                      <span class="mx-0.5 h-6 w-0.5 shrink-0 rounded-xs bg-accent/70" />
                    </Show>

                    {/* Separator */}
                    <div class="mx-0.5 h-4 w-px shrink-0 bg-border" />

                    {/* Tab */}
                    <div
                      data-tab-id={tab.id}
                      class={`group/tab flex h-7.5 max-w-48 shrink-0 cursor-pointer items-center gap-1.5 rounded-xs px-2.5 text-[0.8125rem] leading-normal whitespace-nowrap transition-all duration-100 select-none ${
                        isActive()
                          ? "text-text-primary ring-1 ring-border-focused"
                          : `text-text-muted hover:bg-ghost-hover hover:text-text-secondary`
                      } ${isDragging() ? "opacity-40" : ""}`}
                      onClick={(e) => handleTabClick(tab.id, e)}
                      onMouseDown={(e) => handleTabMouseDown(tab.id, e)}
                    >
                      {/* Tab icon */}
                      <span
                        class={`shrink-0 leading-none ${isActive() ? "text-icon" : "text-icon-muted"}`}
                      >
                        <Switch fallback={<FileIcon size={14} />}>
                          <Match when={tab.type === "graph"}>
                            <GraphIcon size={14} />
                          </Match>
                          <Match when={tab.type === "search"}>
                            <SearchIcon size={14} />
                          </Match>
                          <Match when={tab.type === "settings"}>
                            <SettingsIcon size={14} />
                          </Match>
                        </Switch>
                      </span>

                      {/* Dirty indicator */}
                      <Show when={tab.isDirty}>
                        <span class="size-1 shrink-0 rounded-full bg-accent" />
                      </Show>

                      {/* Tab name */}
                      <Show
                        when={rowEditState()}
                        fallback={
                          <span
                            class="min-w-0 flex-1 truncate py-1.5 leading-none"
                            onDblClick={(event) => {
                              if (tab.type !== "editor" || !tab.filePath) return;
                              event.preventDefault();
                              event.stopPropagation();
                              startRename(tab.filePath, "tab");
                            }}
                          >
                            {stripExtension(tab.fileName)}
                          </span>
                        }
                      >
                        {(editState) => <TabRenameInput editState={editState()} />}
                      </Show>

                      {/* Close button */}
                      <Show when={!rowEditState()}>
                        <button
                          type="button"
                          class={`flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-xs border-none bg-transparent leading-none text-icon-muted transition-all duration-100 hover:bg-ghost-active hover:text-text-primary ${
                            isActive()
                              ? "opacity-80 hover:opacity-100"
                              : "opacity-0 group-hover/tab:opacity-60 group-hover/tab:hover:opacity-100"
                          }`}
                          onClick={(e) => handleCloseClick(tab.id, e)}
                          onMouseDown={(e) => e.stopPropagation()}
                        >
                          <CloseIcon size={12} />
                        </button>
                      </Show>
                    </div>

                    {/* Drop indicator (after the last tab) */}
                    <Show when={showDropAfter()}>
                      <span class="mx-0.5 h-6 w-0.5 shrink-0 rounded-xs bg-accent/70" />
                    </Show>

                    {/* Trailing separator */}
                    <Show when={isLast()}>
                      <span class="mx-0.5 h-4 w-px shrink-0 bg-border" />
                    </Show>
                  </>
                );
              }}
            </For>
          </div>
        </ScrollArea>

        {/* ── Actions ── */}
        <div class="flex shrink-0 items-center gap-0.5 border-l border-border pl-1">
          <button
            type="button"
            class={ACTION_BTN}
            onClick={() => void createAndOpenNewFile()}
            title={t("tabbar.action.new_tab")}
          >
            <PlusIcon />
          </button>

          <Show when={isPluginCommandVisible("graph.cycle")}>
            <button
              type="button"
              class={ACTION_BTN}
              onClick={() => {
                void executePluginCommand("graph.cycle");
              }}
              title={t("tabbar.action.graph_shortcut")}
            >
              <GraphIcon size={14} />
            </button>
          </Show>

          <DropdownMenu>
            <DropdownMenuTrigger class={ACTION_BTN} title={t("tabbar.action.more_actions")}>
              <EllipsisVerticalIcon />
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <Show when={moreActionIds.includes("advanced-search")}>
                <DropdownMenuItem
                  label={t("center.empty.advanced_search")}
                  shortcut="⌘U"
                  onSelect={() => openTab(t("center.empty.advanced_search"), null, "search")}
                />
              </Show>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Floating drag preview — mirrors the file browser's DragPreview */}
      <Show when={draggingTabId() && draggingFileName()}>
        <div
          class="pointer-events-none fixed z-1100 inline-flex max-w-48 items-center gap-1.5 rounded-xs border border-border bg-bg-elevated/96 px-2.5 py-1 text-[0.8125rem] text-text-primary shadow-popover"
          style={{
            left: `${dragPointer().x + 14}px`,
            top: `${dragPointer().y + 14}px`,
          }}
        >
          <FileIcon size={14} class="shrink-0 text-text-muted" />
          <span class="truncate">{stripExtension(draggingFileName() ?? "")}</span>
        </div>
      </Show>
    </div>
  );
}
