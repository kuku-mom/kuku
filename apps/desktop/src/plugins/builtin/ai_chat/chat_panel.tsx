import { createEffect, on, onCleanup, onMount, Show, type JSX } from "solid-js";

import { chatState, loadConfig, saveConfig } from "./chat_store";
import { ChatHeader } from "./components/chat_header";
import { ChatInput } from "./components/chat_input";
import { ChatMessages } from "./components/chat_messages";
import ScrollArea, { type ScrollAreaHandle } from "~/components/scroll_area";
import { KukuIcon, SettingsIcon } from "~/components/icons";
import { openSettings } from "~/stores/files";
import { vaultDragState } from "~/stores/vault_drag";
import { authState, getAuthService } from "~/plugins/builtin/core_auth/auth_service";

function AccessPrompt(): JSX.Element {
  const signInWithKuku = async () => {
    if (chatState.config.saving || authState.loading) return;

    if (chatState.config.provider !== "remote") {
      await saveConfig(
        "remote",
        chatState.config.apiKey,
        chatState.config.model,
        chatState.config.serverUrl,
      );
    }

    openSettings({
      kind: "plugin",
      fillId: "core-auth.settings",
      anchor: "session",
    });

    if (!authState.authenticated) {
      await getAuthService()?.login();
    }
  };

  return (
    <div class="flex flex-1 flex-col items-center justify-center px-6 py-8">
      <div class="flex w-full max-w-80 flex-col items-center gap-5 text-center">
        <div class="space-y-2">
          <h2 class="text-base font-semibold text-text-primary">Set up AI Chat</h2>
          <p class="max-w-60 text-xs/relaxed text-text-muted">
            Use a Gemini API key or sign in with your Kuku account.
          </p>
        </div>

        <button
          type="button"
          class="inline-flex items-center gap-2 rounded-xs border border-accent/30 bg-accent/15 px-4 py-2 text-sm font-medium text-accent transition-colors hover:bg-accent/25 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
          disabled={chatState.config.saving || authState.loading}
          onClick={() => void signInWithKuku()}
        >
          <KukuIcon size={14} />
          {authState.loading ? "Opening..." : "Sign in with Kuku"}
        </button>

        <p class="max-w-55 text-[0.6875rem] leading-relaxed text-text-muted/60">
          Sign in once and use Kuku Remote without managing a local API key here.
        </p>

        <div class="flex w-full max-w-60 items-center gap-3">
          <div class="h-px flex-1 bg-border" />
          <span class="text-[0.6875rem] tracking-[0.16em] text-text-muted uppercase">or</span>
          <div class="h-px flex-1 bg-border" />
        </div>

        <button
          type="button"
          class="inline-flex items-center gap-2 rounded-xs border border-accent/30 bg-accent/15 px-4 py-2 text-sm font-medium text-accent transition-colors hover:bg-accent/25 active:scale-[0.98]"
          onClick={() =>
            openSettings({
              kind: "plugin",
              fillId: "ai-chat.settings",
              anchor: "api-key",
            })
          }
        >
          <SettingsIcon size={14} />
          Open Settings
        </button>

        <p class="max-w-55 text-[0.6875rem] leading-relaxed text-text-muted/60">
          Add your Gemini API key in AI Chat settings to use local BYOK mode.
        </p>

        <Show when={authState.error}>
          {(error) => <p class="max-w-60 text-[0.6875rem] text-error">{error()}</p>}
        </Show>
        <Show when={chatState.config.error}>
          {(error) => <p class="max-w-60 text-[0.6875rem] text-error">{error()}</p>}
        </Show>
      </div>
    </div>
  );
}

function RemotePermissionPrompt(): JSX.Element {
  return (
    <div class="flex flex-1 flex-col items-center justify-center px-6 py-8">
      <div class="flex flex-col items-center gap-5 text-center">
        <div class="flex size-12 items-center justify-center rounded-xs border border-border bg-bg-secondary/60">
          <SettingsIcon size={22} />
        </div>

        <div class="space-y-2">
          <h2 class="text-base font-semibold text-text-primary">Permission required</h2>
          <p class="max-w-60 text-xs/relaxed text-text-muted">
            Allow AI Chat to use your Kuku server session in Account settings.
          </p>
        </div>

        <button
          type="button"
          class="inline-flex items-center gap-2 rounded-xs border border-accent/30 bg-accent/15 px-4 py-2 text-sm font-medium text-accent transition-colors hover:bg-accent/25 active:scale-[0.98]"
          onClick={() =>
            openSettings({
              kind: "plugin",
              fillId: "core-auth.settings",
              anchor: "authorizations",
            })
          }
        >
          <SettingsIcon size={14} />
          Open Settings
        </button>
      </div>
    </div>
  );
}

// ── Main Chat Panel ──

function ChatPanel(): JSX.Element {
  let scrollHandle: ScrollAreaHandle | undefined;
  let pendingScrollBehavior: ScrollBehavior | null = null;
  let pendingScrollFrame = 0;
  let userScrolledAway = false;

  const isApiKeyMissing = () =>
    chatState.config.provider === "gemini" && !chatState.config.loading && !chatState.config.apiKey;
  const needsRemoteLogin = () =>
    chatState.config.provider === "remote" && !chatState.config.loading && !authState.authenticated;
  const needsRemotePermission = () =>
    chatState.config.provider === "remote" &&
    !chatState.config.loading &&
    authState.authenticated &&
    !getAuthService()?.isPluginAuthorized("ai-chat");

  // Reload config when panel mounts so we pick up changes made in Settings.
  onMount(() => {
    void loadConfig();
  });

  createEffect(() => {
    if (chatState.config.provider === "remote") {
      void getAuthService()?.authorizationHeaders("ai-chat");
    }
  });

  onCleanup(() => {
    if (pendingScrollFrame) {
      cancelAnimationFrame(pendingScrollFrame);
    }
  });

  // ── Scroll helpers ──

  function isNearBottom(): boolean {
    if (!scrollHandle) return true;
    const position = scrollHandle.getScrollPosition();
    const threshold = 80;
    return position.scrollHeight - position.top - position.height < threshold;
  }

  function scrollToBottom(behavior: ScrollBehavior = "auto"): void {
    if (!scrollHandle) return;
    scrollHandle.update();
    const position = scrollHandle.getScrollPosition();
    scrollHandle.scrollTo({
      top: position.scrollHeight,
      behavior,
    });
    userScrolledAway = false;
  }

  function flushPendingScroll(): void {
    if (!pendingScrollBehavior) return;
    const behavior = pendingScrollBehavior;
    pendingScrollBehavior = null;
    scrollToBottom(behavior);
  }

  function cancelPendingScroll(): void {
    pendingScrollBehavior = null;
    if (!pendingScrollFrame) return;
    cancelAnimationFrame(pendingScrollFrame);
    pendingScrollFrame = 0;
  }

  function scheduleScrollToBottom(behavior: ScrollBehavior = "auto"): void {
    if (userScrolledAway) return;
    pendingScrollBehavior = behavior;
    if (pendingScrollFrame) return;

    pendingScrollFrame = requestAnimationFrame(() => {
      scrollHandle?.update();
      pendingScrollFrame = requestAnimationFrame(() => {
        pendingScrollFrame = 0;
        flushPendingScroll();
      });
    });
  }

  function handleScroll(): void {
    userScrolledAway = !isNearBottom();
    if (userScrolledAway) {
      cancelPendingScroll();
    }
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
      scheduleScrollToBottom("auto");
    }
  });

  // Reset scroll position when the active session changes.
  createEffect(
    on(
      () => chatState.activeSessionId,
      () => {
        userScrolledAway = false;
        scheduleScrollToBottom("auto");
      },
    ),
  );

  // ── Render ──

  return (
    <div class="relative flex h-full min-h-0 flex-col bg-bg-primary" data-ai-chat-dropzone="true">
      <Show when={vaultDragState.chatDropActive}>
        <div class="pointer-events-none absolute inset-2 z-20 rounded-xs border border-accent/60 bg-accent/8" />
      </Show>
      <ChatHeader />

      <Show when={!(isApiKeyMissing() || needsRemoteLogin())} fallback={<AccessPrompt />}>
        <Show when={!needsRemotePermission()} fallback={<RemotePermissionPrompt />}>
          <ScrollArea
            axis="y"
            class="min-h-0 flex-1"
            handleRef={(handle) => {
              scrollHandle = handle;
            }}
            onViewportReady={() => {
              flushPendingScroll();
            }}
            onScroll={() => {
              handleScroll();
            }}
          >
            <ChatMessages />
          </ScrollArea>

          <ChatInput />
        </Show>
      </Show>
    </div>
  );
}

export default ChatPanel;
