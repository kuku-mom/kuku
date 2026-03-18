import { For, Show } from "solid-js";

import { CloseIcon, EllipsisVerticalIcon, FileIcon, PlusIcon } from "~/components/icons";
import ScrollArea from "~/components/scroll_area";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui";
import { closeTab, createAndOpenNewFile, filesState, openTab, setActiveTab } from "~/stores/files";

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
    <div class="relative z-10 border-b border-border bg-bg-secondary">
      <div class="flex h-9.5 items-center gap-1 px-2">
        {/* ── Tab list (horizontal scroll, hidden scrollbar) ── */}
        <ScrollArea
          class="min-w-0 flex-1"
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
                    <span class="mx-0.5 h-4 w-px shrink-0 bg-border" />

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
                      {/* File icon */}
                      <span
                        class={`flex h-5 shrink-0 items-center ${
                          isActive() ? `text-icon` : `text-icon-muted`
                        }`}
                      >
                        <FileIcon size={14} />
                      </span>

                      {/* Dirty indicator */}
                      <Show when={tab.isDirty}>
                        <span class="flex h-5 shrink-0 items-center">
                          <span class="size-1.5 rounded-full bg-accent" />
                        </span>
                      </Show>

                      {/* Tab name */}
                      <span class="min-w-0 flex-1 truncate">{stripExtension(tab.fileName)}</span>

                      {/* Close button */}
                      <span
                        class={`flex h-5 shrink-0 items-center ${
                          isActive()
                            ? "opacity-80 hover:opacity-100"
                            : `opacity-0 group-hover/tab:opacity-60 group-hover/tab:hover:opacity-100`
                        }`}
                      >
                        <button
                          type="button"
                          class="flex size-4 cursor-pointer items-center justify-center rounded-sm border-none bg-transparent text-icon-muted transition-all duration-100 hover:bg-ghost-active hover:text-text-primary"
                          onClick={(e) => handleCloseClick(tab.id, e)}
                        >
                          <CloseIcon size={8} />
                        </button>
                      </span>
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
