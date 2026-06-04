import { For, Show, createSignal, onCleanup, onMount, type JSX } from "solid-js";

import { switchSession } from "../chat_store";
import type { ChatSessionSummary } from "../types";
import { focusMenuItem, handleMenuKeyboard } from "./menu_keyboard";
import { MenuPopover } from "./menu_popover";
import { t } from "~/i18n";

interface ChatSessionMenuProps {
  items: ChatSessionSummary[];
  activeSessionId: string | null;
  defaultOpen?: boolean;
  canCloseSession?: (item: ChatSessionSummary) => boolean;
  onCloseSession?: (id: string) => void;
}

function ChatSessionMenu(props: ChatSessionMenuProps): JSX.Element {
  const [open, setOpen] = createSignal(props.defaultOpen ?? false);
  let rootRef: HTMLDivElement | undefined;
  let triggerRef: HTMLButtonElement | undefined;
  let menuRef: HTMLDivElement | undefined;
  const activeItem = () =>
    props.items.find((item) => item.id === props.activeSessionId) ?? props.items[0] ?? null;
  const hasItems = () => props.items.length > 0;

  const closeMenu = () => setOpen(false);

  const openMenuFromKeyboard = (event: KeyboardEvent, position: "first" | "last" = "first") => {
    event.preventDefault();
    if (!hasItems()) return;
    setOpen(true);
    queueMicrotask(() => focusMenuItem(menuRef, position));
  };

  const selectSession = (id: string) => {
    setOpen(false);
    if (id === props.activeSessionId) return;
    switchSession(id);
  };
  const closeSession = (id: string) => {
    const item = props.items.find((candidate) => candidate.id === id);
    if (!item || props.canCloseSession?.(item) === false) return;
    setOpen(false);
    props.onCloseSession?.(id);
  };

  onMount(() => {
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!open()) return;
      const target = event.target;
      if (target instanceof Node && rootRef?.contains(target)) return;
      if (target instanceof Node && menuRef?.contains(target)) return;
      setOpen(false);
    };

    document.addEventListener("pointerdown", closeOnOutsidePointer);
    onCleanup(() => document.removeEventListener("pointerdown", closeOnOutsidePointer));
  });

  return (
    <div
      class="relative min-w-0"
      ref={(element) => {
        rootRef = element;
      }}
      onKeyDown={(event) => {
        handleMenuKeyboard(event, { root: rootRef, menu: menuRef, close: closeMenu });
      }}
    >
      <button
        ref={(element) => {
          triggerRef = element;
        }}
        type="button"
        data-kuku-session-switcher="true"
        data-kuku-menu-trigger="true"
        class="hover:border-border-strong flex h-7 max-w-[10rem] min-w-0 items-center gap-1.5 rounded-md border border-border bg-bg-secondary px-2 text-[0.6875rem] text-text-secondary transition outline-none enabled:hover:bg-ghost-hover enabled:hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
        title={t("chat.header.session_select")}
        aria-label={t("chat.header.session_select")}
        aria-haspopup="menu"
        aria-expanded={open() ? "true" : "false"}
        disabled={!hasItems()}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
            openMenuFromKeyboard(event, "first");
          } else if (event.key === "ArrowUp") {
            openMenuFromKeyboard(event, "last");
          }
        }}
      >
        <span class="min-w-0 truncate">{activeItem()?.title ?? t("chat.header.session_select")}</span>
        <svg
          class="size-3 shrink-0"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      <Show when={hasItems()}>
        <MenuPopover
          open={open()}
          anchor={() => triggerRef}
          widthClass="w-56"
          widthPx={224}
          dataAttributes={{ "data-kuku-session-menu": "true" }}
          onSurfaceMount={(element) => {
            menuRef = element;
          }}
          onKeyDown={(event) =>
            handleMenuKeyboard(event, { root: rootRef, menu: menuRef, close: closeMenu })
          }
        >
          <For each={props.items}>
            {(item) => (
              <ChatSessionMenuItem
                item={item}
                active={item.id === props.activeSessionId}
                onSelect={selectSession}
                canClose={props.canCloseSession?.(item) ?? true}
                onClose={props.onCloseSession ? closeSession : undefined}
              />
            )}
          </For>
        </MenuPopover>
      </Show>
    </div>
  );
}

function ChatSessionMenuItem(props: {
  item: ChatSessionSummary;
  active: boolean;
  onSelect: (id: string) => void;
  canClose: boolean;
  onClose?: (id: string) => void;
}): JSX.Element {
  const closeLabel = () => `${t("chat.header.close_session")}: ${props.item.title}`;

  return (
    <div
      class={`group flex h-8 w-full items-center rounded-xs transition-colors duration-75 hover:bg-ghost-hover ${
        props.active ? "bg-ghost-hover text-text-primary" : "text-text-primary"
      }`}
    >
      <button
        type="button"
        role="menuitem"
        data-kuku-session-menu-item={props.item.id}
        aria-current={props.active ? "true" : undefined}
        class="flex h-full min-w-0 flex-1 cursor-pointer items-center justify-between gap-2 rounded-xs py-0 pr-1 pl-2.5 text-left text-[0.8125rem] leading-normal outline-none transition-colors duration-75"
        onClick={() => props.onSelect(props.item.id)}
      >
        <span class="min-w-0 truncate">{props.item.title}</span>
        <Show when={props.active}>
          <svg
            class="size-3 shrink-0 text-text-muted"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M20 6L9 17l-5-5" />
          </svg>
        </Show>
      </button>
      <Show when={props.onClose}>
        <button
          type="button"
          role="menuitem"
          data-kuku-close-chat-session="true"
          data-kuku-close-chat-session-id={props.item.id}
          class="mr-1 flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-xs text-text-muted outline-none transition-colors duration-75 enabled:hover:bg-ghost-hover enabled:hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-35"
          title={closeLabel()}
          aria-label={closeLabel()}
          disabled={!props.canClose}
          onClick={() => props.onClose?.(props.item.id)}
        >
          <svg
            class="size-3"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            aria-hidden="true"
          >
            <path d="M6 6l12 12" />
            <path d="M18 6L6 18" />
          </svg>
        </button>
      </Show>
    </div>
  );
}

export { ChatSessionMenu };
