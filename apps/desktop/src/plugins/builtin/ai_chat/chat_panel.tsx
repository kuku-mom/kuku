import { createEffect, on, onCleanup, onMount, Show, type JSX } from "solid-js";
import { OverlayScrollbars } from "overlayscrollbars";

import { chatState, loadConfig } from "./chat_store";
import { ChatHeader } from "./components/chat_header";
import { ChatInput } from "./components/chat_input";
import { ChatMessages } from "./components/chat_messages";
import { SettingsIcon } from "~/components/icons";
import { openTab } from "~/stores/files";

// ── API Key Missing Prompt ──

function ApiKeyPrompt(): JSX.Element {
  return (
    <div class="flex flex-1 flex-col items-center justify-center px-6 py-8">
      <div class="flex flex-col items-center gap-5 text-center">
        {/* Icon */}
        <div class="flex size-12 items-center justify-center rounded-full border border-border bg-bg-secondary/60">
          <SettingsIcon size={22} />
        </div>

        {/* Title & description */}
        <div class="space-y-2">
          <h2 class="text-base font-semibold text-text-primary">API Key Required</h2>
          <p class="max-w-60 text-xs/relaxed  text-text-muted">
            To use AI Chat, you need to configure your Gemini API key in Settings first.
          </p>
        </div>

        {/* Open Settings button */}
        <button
          type="button"
          class="inline-flex items-center gap-2 rounded-xs border border-accent/30 bg-accent/15 px-4 py-2 text-sm font-medium text-accent transition-colors hover:bg-accent/25 active:scale-[0.98]"
          onClick={() => openTab("Settings", null, "settings")}
        >
          <SettingsIcon size={14} />
          Open Settings
        </button>

        {/* Hint */}
        <p class="max-w-55 text-[0.6875rem] leading-relaxed text-text-muted/60">
          Navigate to the <span class="font-medium text-text-muted">AI Chat</span> section and enter
          your API key, then come back here.
        </p>
      </div>
    </div>
  );
}

// ── Main Chat Panel ──

function ChatPanel(): JSX.Element {
  let scrollHost: HTMLDivElement | undefined;
  let osInstance: OverlayScrollbars | undefined;
  let userScrolledAway = false;

  const isApiKeyMissing = () => !chatState.config.loading && !chatState.config.apiKey;

  // Reload config when panel mounts so we pick up changes made in Settings.
  onMount(() => {
    void loadConfig();
  });

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

      <Show when={!isApiKeyMissing()} fallback={<ApiKeyPrompt />}>
        <div ref={scrollHost} class="min-h-0 flex-1">
          <ChatMessages />
        </div>

        <ChatInput />
      </Show>
    </div>
  );
}

export default ChatPanel;
