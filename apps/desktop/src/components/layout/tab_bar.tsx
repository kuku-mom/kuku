import { createEffect, createSignal, For, Show } from "solid-js";

import { CloseIcon, EllipsisVerticalIcon, FileIcon, PlusIcon } from "~/components/icons";
import ScrollArea from "~/components/scroll_area";
import { closeTab, filesState, openTab, setActiveTab } from "~/stores/files";

// ── Helpers ──

function stripExtension(name: string): string {
  const dotIndex = name.lastIndexOf(".");
  return dotIndex > 0 ? name.substring(0, dotIndex) : name;
}

// ── Styles ──

const ACTION_BTN =
  "flex size-[26px] cursor-pointer items-center justify-center rounded-[6px] border-none bg-transparent text-icon-muted transition-all duration-100 hover:bg-ghost-hover hover:text-icon";

// ── Menu types ──

type MenuItem =
  | { type: "action"; label: string; shortcut?: string; onClick: () => void }
  | { type: "separator" };

// ── KebabMenu ──

function KebabMenu(props: { items: MenuItem[] }) {
  const [open, setOpen] = createSignal(false);
  const [pos, setPos] = createSignal({ top: 0, right: 0 });
  let triggerRef: HTMLButtonElement | undefined;
  let menuRef: HTMLDivElement | undefined;

  function updatePosition() {
    if (!triggerRef) return;
    const rect = triggerRef.getBoundingClientRect();
    setPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
  }

  const handleClickOutside = (e: PointerEvent) => {
    if (
      open() &&
      triggerRef &&
      menuRef &&
      !triggerRef.contains(e.target as Node) &&
      !menuRef.contains(e.target as Node)
    ) {
      setOpen(false);
    }
  };

  const handleEscape = (e: KeyboardEvent) => {
    if (e.key === "Escape" && open()) {
      setOpen(false);
    }
  };

  createEffect(() => {
    if (open()) {
      document.addEventListener("pointerdown", handleClickOutside);
      document.addEventListener("keydown", handleEscape);
    } else {
      document.removeEventListener("pointerdown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    }
  });

  return (
    <div class="relative">
      <button
        ref={triggerRef}
        type="button"
        title="More actions"
        class={`${ACTION_BTN} ${open() ? "bg-ghost-hover text-icon" : ""}`}
        onClick={() => {
          updatePosition();
          setOpen((v) => !v);
        }}
      >
        <EllipsisVerticalIcon />
      </button>

      <Show when={open()}>
        <div
          ref={menuRef}
          class="fixed z-1000 min-w-44 rounded-lg border border-border bg-bg-secondary p-1 shadow-[0_4px_16px_rgba(0,0,0,0.28),0_0_0_1px_rgba(0,0,0,0.06)]"
          style={{ top: `${pos().top}px`, right: `${pos().right}px` }}
        >
          <For each={props.items}>
            {(item) => (
              <Show
                when={item.type === "action" && item}
                fallback={<div class="mx-1.5 my-1 h-px bg-border" />}
              >
                {(actionItem) => (
                  <button
                    type="button"
                    class="flex w-full cursor-pointer items-center justify-between gap-4 rounded-[5px] border-none bg-transparent px-2.5 py-1.5 text-[13px] text-text-primary transition-[background] duration-80 hover:bg-ghost-hover"
                    onClick={() => {
                      const a = actionItem() as { type: "action"; onClick: () => void };
                      a.onClick();
                      setOpen(false);
                    }}
                  >
                    <span class="whitespace-nowrap">
                      {(actionItem() as { label: string }).label}
                    </span>
                    <Show when={(actionItem() as { shortcut?: string }).shortcut}>
                      <span class="text-[11px] text-text-muted">
                        {(actionItem() as { shortcut?: string }).shortcut}
                      </span>
                    </Show>
                  </button>
                )}
              </Show>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

// ── TabBar ──

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

  const menuItems: MenuItem[] = [
    { type: "action", label: "New Tab", shortcut: "⌘N", onClick: () => openTab("Untitled") },
    { type: "separator" },
    {
      type: "action",
      label: "Settings",
      shortcut: "⌘,",
      onClick: () => openTab("Settings", null, "settings"),
    },
  ];

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
                      class={`group/tab flex h-7.5 max-w-48 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-[13px]/3.5 whitespace-nowrap transition-all duration-100 select-none ${
                        isActive()
                          ? "text-text-primary ring-1 ring-border-focused"
                          : "text-text-muted hover:bg-ghost-hover hover:text-text-secondary"
                      }`}
                      onClick={() => setActiveTab(tab.id)}
                      onMouseDown={(e) => handleMiddleClick(tab.id, e)}
                    >
                      {/* File icon */}
                      <FileIcon
                        size={14}
                        class={`shrink-0 ${isActive() ? "text-icon" : "text-icon-muted"}`}
                      />

                      {/* Dirty indicator */}
                      <Show when={tab.isDirty}>
                        <span class="size-1.5 shrink-0 rounded-full bg-accent" />
                      </Show>

                      {/* Tab name */}
                      <span class="min-w-0 flex-1 truncate">{stripExtension(tab.fileName)}</span>

                      {/* Close button */}
                      <button
                        type="button"
                        class={`flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-sm border-none bg-transparent text-icon-muted transition-all duration-100 hover:bg-ghost-active hover:text-text-primary ${
                          isActive()
                            ? "opacity-80 hover:opacity-100"
                            : "opacity-0 group-hover/tab:opacity-60 group-hover/tab:hover:opacity-100"
                        }`}
                        onClick={(e) => handleCloseClick(tab.id, e)}
                      >
                        <CloseIcon size={8} />
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
            onClick={() => openTab("Untitled")}
            title="New Tab"
          >
            <PlusIcon />
          </button>
          <KebabMenu items={menuItems} />
        </div>
      </div>
    </div>
  );
}
