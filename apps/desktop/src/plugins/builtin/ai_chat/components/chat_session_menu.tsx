import { For, Show, createSignal, onCleanup, onMount, type JSX } from "solid-js";

import { switchSession } from "../chat_store";
import type { ChatSessionSummary } from "../types";
import { t } from "~/i18n";

interface ChatSessionMenuProps {
  items: ChatSessionSummary[];
  activeSessionId: string | null;
  defaultOpen?: boolean;
}

function ChatSessionMenu(props: ChatSessionMenuProps): JSX.Element {
  const [open, setOpen] = createSignal(props.defaultOpen ?? false);
  let rootRef: HTMLDivElement | undefined;
  const activeItem = () =>
    props.items.find((item) => item.id === props.activeSessionId) ?? props.items[0] ?? null;
  const hasItems = () => props.items.length > 0;

  const selectSession = (id: string) => {
    setOpen(false);
    if (id === props.activeSessionId) return;
    switchSession(id);
  };

  onMount(() => {
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!open()) return;
      const target = event.target;
      if (target instanceof Node && rootRef?.contains(target)) return;
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
        if (event.key === "Escape") setOpen(false);
      }}
    >
      <button
        type="button"
        data-kuku-session-switcher="true"
        class="hover:border-border-strong flex h-7 max-w-[10rem] min-w-0 items-center gap-1.5 rounded-md border border-border bg-bg-secondary px-2 text-[0.6875rem] text-text-secondary transition outline-none enabled:hover:bg-ghost-hover enabled:hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
        title={t("chat.header.session_select")}
        aria-label={t("chat.header.session_select")}
        aria-haspopup="menu"
        aria-expanded={open() ? "true" : "false"}
        disabled={!hasItems()}
        onClick={() => setOpen((current) => !current)}
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

      <Show when={open() && hasItems()}>
        <div
          role="menu"
          data-kuku-session-menu="true"
          class="absolute top-full left-0 z-1000 mt-1 w-56 overflow-hidden rounded-sm border border-border/40 bg-bg-elevated p-1.5 [box-shadow:var(--shadow-context-surface)]"
        >
          <For each={props.items}>
            {(item) => (
              <ChatSessionMenuItem
                item={item}
                active={item.id === props.activeSessionId}
                onSelect={selectSession}
              />
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

function ChatSessionMenuItem(props: {
  item: ChatSessionSummary;
  active: boolean;
  onSelect: (id: string) => void;
}): JSX.Element {
  return (
    <button
      type="button"
      role="menuitem"
      data-kuku-session-menu-item={props.item.id}
      aria-current={props.active ? "true" : undefined}
      class={`flex h-8 w-full cursor-pointer items-center justify-between gap-4 rounded-xs px-2.5 text-left text-[0.8125rem] leading-normal outline-none transition-colors duration-75 hover:bg-ghost-hover ${
        props.active ? "bg-ghost-hover text-text-primary" : "text-text-primary"
      }`}
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
  );
}

export { ChatSessionMenu };
