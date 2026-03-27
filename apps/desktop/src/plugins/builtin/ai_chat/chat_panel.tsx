import { createEffect, on, onCleanup, onMount, type JSX } from "solid-js";
import { OverlayScrollbars } from "overlayscrollbars";

import { chatState } from "./chat_store";
import { ChatHeader } from "./components/chat_header";
import { ChatInput } from "./components/chat_input";
import { ChatMessages } from "./components/chat_messages";

function ChatPanel(): JSX.Element {
  let scrollHost: HTMLDivElement | undefined;
  let osInstance: OverlayScrollbars | undefined;
  let userScrolledAway = false;

  // ── OverlayScrollbars ──

  onMount(() => {
    if (!scrollHost) return;

    // eslint-disable-next-line new-cap -- OverlayScrollbars is a factory, not a constructor
    osInstance = OverlayScrollbars(scrollHost, {
      scrollbars: {
        theme: "os-theme-kuku",
        autoHide: "scroll",
        autoHideDelay: 800,
      },
      overflow: { x: "hidden" },
    });

    // Listen for manual scrolls so we don't fight the user.
    const viewport = osInstance.elements().viewport;
    viewport.addEventListener("scroll", handleScroll, { passive: true });
    onCleanup(() => viewport.removeEventListener("scroll", handleScroll));
  });

  onCleanup(() => {
    osInstance?.destroy();
  });

  // ── Scroll helpers ──

  function getViewport(): HTMLElement | undefined {
    return osInstance?.elements().viewport;
  }

  function isNearBottom(): boolean {
    const viewport = getViewport();
    if (!viewport) return true;
    const threshold = 80;
    return viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < threshold;
  }

  function scrollToBottom(smooth = true): void {
    const viewport = getViewport();
    if (!viewport) return;
    viewport.scrollTo({
      top: viewport.scrollHeight,
      behavior: smooth ? "smooth" : "instant",
    });
  }

  function handleScroll(): void {
    userScrolledAway = !isNearBottom();
  }

  // ── Auto-scroll on new / updated messages ──

  createEffect(() => {
    const activeId = chatState.activeSessionId;
    const session = activeId ? (chatState.sessions[activeId] ?? null) : null;
    const count = session?.messages.length ?? 0;
    if (!activeId || count === 0) return;

    // Subscribe to the last message's content so streaming deltas trigger the effect.
    const last = session?.messages[count - 1];
    void (last?.kind === "text" ? last.content.length : last?.kind);

    if (!userScrolledAway) {
      requestAnimationFrame(() => scrollToBottom());
    }
  });

  // Reset scroll position when the active session changes.
  createEffect(
    on(
      () => chatState.activeSessionId,
      () => {
        userScrolledAway = false;
        requestAnimationFrame(() => scrollToBottom(false));
      },
    ),
  );

  // ── Render ──

  return (
    <div class="flex h-full min-h-0 flex-col bg-bg-primary">
      <ChatHeader />

      <div ref={scrollHost} class="min-h-0 flex-1">
        <ChatMessages />
      </div>

      <ChatInput />
    </div>
  );
}

export default ChatPanel;
