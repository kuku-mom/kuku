import type { OverlayScrollbarsComponentRef } from "overlayscrollbars-solid";

import { createEffect, For, Match, Show, Switch } from "solid-js";

import {
  CloseIcon,
  EllipsisVerticalIcon,
  FileIcon,
  GraphIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
} from "~/components/icons";
import ScrollArea from "~/components/scroll_area";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui";
import { closeTab, createAndOpenNewFile, filesState, openTab, setActiveTab } from "~/stores/files";

// NOTE: The following CSS rules live in scrollbar.css (library DOM we can't add classes to):
//   .tab-bar .os-scrollbar-horizontal { top: 0; bottom: auto; }
//   .tab-bar-tabs [data-overlayscrollbars-contents] { display:flex; align-items:center; padding:4px 2px; }

// ── Helpers ──

function stripExtension(name: string): string {
  const dotIndex = name.lastIndexOf(".");
  return dotIndex > 0 ? name.substring(0, dotIndex) : name;
}

// ── Styles ──

const ACTION_BTN =
  "flex size-[26px] cursor-pointer items-center justify-center rounded-[6px] border-none bg-transparent text-icon-muted transition-all duration-100 hover:bg-ghost-hover hover:text-icon data-[expanded]:bg-ghost-hover data-[expanded]:text-icon";

// ── Component ──

export default function TabBar() {
  let osRef: OverlayScrollbarsComponentRef | undefined;

  const getViewport = () => osRef?.osInstance()?.elements().viewport;

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

  // ── Tab interaction handlers ──

  const handleMiddleClick = (tabId: string, e: MouseEvent) => {
    if (e.button === 1) {
      e.preventDefault();
      closeTab(tabId);
    }
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
          ref={(r: OverlayScrollbarsComponentRef) => (osRef = r)}
          class="tab-bar-tabs min-w-0 flex-1"
          axis="x"
          horizontalWheel
          options={{ scrollbars: { visibility: "hidden" } }}
        >
          <div class="flex items-center py-1">
            <For each={filesState.tabs}>
              {(tab, index) => {
                const isActive = () => tab.id === filesState.activeTabId;
                const isLast = () => index() === filesState.tabs.length - 1;

                return (
                  <>
                    {/* Separator */}
                    <div class="mx-0.5 h-4 w-px shrink-0 bg-border" />

                    {/* Tab */}
                    <div
                      data-tab-id={tab.id}
                      class={`group/tab flex h-7.5 max-w-48 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-[0.8125rem] leading-normal whitespace-nowrap transition-all duration-100 select-none ${
                        isActive()
                          ? "text-text-primary ring-1 ring-border-focused"
                          : `text-text-muted hover:bg-ghost-hover hover:text-text-secondary`
                      }`}
                      onClick={() => setActiveTab(tab.id)}
                      onMouseDown={(e) => handleMiddleClick(tab.id, e)}
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
                      <span class="min-w-0 flex-1 truncate py-1.5 leading-none">
                        {stripExtension(tab.fileName)}
                      </span>

                      {/* Close button */}
                      <button
                        type="button"
                        class={`flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-sm border-none bg-transparent leading-none text-icon-muted transition-all duration-100 hover:bg-ghost-active hover:text-text-primary ${
                          isActive()
                            ? "opacity-80 hover:opacity-100"
                            : "opacity-0 group-hover/tab:opacity-60 group-hover/tab:hover:opacity-100"
                        }`}
                        onClick={(e) => handleCloseClick(tab.id, e)}
                      >
                        <CloseIcon size={12} />
                      </button>
                    </div>

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
            title="New Tab"
          >
            <PlusIcon />
          </button>

          <DropdownMenu>
            <DropdownMenuTrigger class={ACTION_BTN} title="More actions">
              <EllipsisVerticalIcon />
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem
                label="New Tab"
                shortcut="⌘N"
                onSelect={() => void createAndOpenNewFile()}
              />
              <DropdownMenuSeparator />
              <DropdownMenuItem
                label="Settings"
                shortcut="⌘,"
                onSelect={() => openTab("Settings", null, "settings")}
              />
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  );
}
