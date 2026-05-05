import { createEffect, createSignal, For, on, Show, type JSX } from "solid-js";

import { BrainIcon, GraphIcon } from "~/components/icons";
import { t, tf } from "~/i18n";
import { sendMessage, switchMode } from "~/plugins/builtin/ai_chat/chat_store";
import { getActiveTab, openTab } from "~/stores/files";
import { openRightPanelView } from "~/stores/layout";
import { vaultState } from "~/stores/vault";

import {
  acceptMemorySuggestion,
  clearHeldMemory,
  dismissMemorySuggestion,
  memoryState,
  refreshMemoryContext,
  rememberActiveNote,
  rememberVault,
  setGBrainEnabled,
} from "./gbrain_memory_store";

type BusyAction = "remember" | "vault" | "ask" | "accept" | "dismiss" | null;

function suggestionLabel(kind: string): string {
  switch (kind) {
    case "rememberNote":
      return t("gbrain.suggestion.remember_note");
    case "extractInsight":
      return t("gbrain.suggestion.extract_insight");
    case "suggestLink":
      return t("gbrain.suggestion.suggest_link");
    case "timelineEntry":
      return t("gbrain.suggestion.timeline_entry");
    default:
      return t("gbrain.suggestion.related_memory");
  }
}

function statusLabel(): string {
  if (!memoryState.enabled) return t("gbrain.memory.disabled");
  if (memoryState.heldMemory && memoryState.status === "off") return t("gbrain.hold.label");
  switch (memoryState.status) {
    case "ready":
      return t("gbrain.memory.ready");
    case "using":
      return t("gbrain.memory.using");
    case "needsReview":
      return t("gbrain.memory.needs_review");
    default:
      return t("gbrain.memory.off");
  }
}

function StatusDot(): JSX.Element {
  return (
    <span
      class="size-1.5 shrink-0 rounded-full bg-text-muted/30"
      classList={{
        "bg-accent/70": memoryState.status === "using" || memoryState.status === "needsReview",
      }}
      aria-hidden="true"
    />
  );
}

export default function GBrainPanel(): JSX.Element {
  let textareaRef: HTMLTextAreaElement | undefined;
  const [draft, setDraft] = createSignal("");
  const [busy, setBusy] = createSignal<BusyAction>(null);
  const [status, setStatus] = createSignal<string | null>(null);
  const [panelError, setPanelError] = createSignal<string | null>(null);

  createEffect(
    on(
      () => getActiveTab()?.filePath,
      () => {
        void refreshMemoryContext();
      },
    ),
  );

  async function rememberCurrent(): Promise<void> {
    if (busy()) return;
    setBusy("remember");
    setPanelError(null);
    setStatus(null);
    try {
      const ok = await rememberActiveNote();
      setStatus(ok ? t("gbrain.status.held_current") : t("gbrain.error.open_note_first"));
    } catch (error) {
      setPanelError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }

  async function importVault(): Promise<void> {
    if (busy()) return;
    setBusy("vault");
    setPanelError(null);
    setStatus(null);
    try {
      const imported = await rememberVault();
      if (imported == null) {
        setStatus(t("gbrain.error.open_vault_first"));
      } else {
        setStatus(tf("gbrain.status.vault_remembered_count", { count: String(imported) }));
      }
    } catch (error) {
      setPanelError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }

  async function askMemory(request: string): Promise<void> {
    const trimmed = request.trim();
    if (!trimmed || busy()) return;
    setBusy("ask");
    setPanelError(null);
    try {
      setGBrainEnabled(true);
      await refreshMemoryContext();
      await switchMode("ask");
      openRightPanelView("ai-chat.panel");
      const sent = await sendMessage(trimmed, {
        includeSelectedText: true,
        memoryMode: "force",
      });
      if (!sent) setPanelError(t("gbrain.error.ai_unavailable"));
    } finally {
      setBusy(null);
    }
  }

  async function useRelated(slug: string, title: string): Promise<void> {
    await askMemory(tf("gbrain.prompt.use_related", { title, slug }));
  }

  async function askForCurrentConnections(): Promise<void> {
    if (memoryState.activeTitle) {
      await askMemory(
        tf("gbrain.prompt.related_note", {
          name: memoryState.activeTitle,
        }),
      );
      return;
    }
    await askMemory(t("gbrain.prompt.related_general"));
  }

  function releaseHeldMemory(): void {
    clearHeldMemory();
    setStatus(t("gbrain.hold.released"));
  }

  function turnOnGBrain(): void {
    setGBrainEnabled(true);
    setStatus(t("gbrain.status.enabled"));
    void refreshMemoryContext();
  }

  function turnOffGBrain(): void {
    setGBrainEnabled(false);
    setStatus(t("gbrain.status.disabled"));
  }

  async function acceptSuggestion(id: string): Promise<void> {
    if (busy()) return;
    setBusy("accept");
    setPanelError(null);
    try {
      await acceptMemorySuggestion(id);
    } catch (error) {
      setPanelError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }

  async function dismissSuggestion(id: string): Promise<void> {
    if (busy()) return;
    setBusy("dismiss");
    setPanelError(null);
    try {
      await dismissMemorySuggestion(id);
    } catch (error) {
      setPanelError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div class="flex h-full min-h-0 flex-col bg-bg-primary">
      <header class="flex h-10 shrink-0 items-center justify-between border-b border-border bg-bg-primary px-3">
        <div class="flex min-w-0 items-center gap-2">
          <StatusDot />
          <span class="truncate text-[0.6875rem] font-medium tracking-wide text-text-muted">
            {t("gbrain.title")}
          </span>
        </div>
      </header>

      <main class="min-h-0 flex-1 overflow-auto">
        <div class="space-y-4 p-3">
          <section class="space-y-2.5">
            <div class="flex min-w-0 items-start gap-2">
              <div class="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-sm border border-border/60 bg-bg-secondary/60 text-text-muted">
                <BrainIcon size={14} />
              </div>
              <div class="min-w-0 flex-1">
                <div class="flex min-w-0 items-center justify-between gap-2">
                  <p class="truncate text-[0.8125rem] font-medium text-text-primary">
                    {memoryState.activeTitle || t("gbrain.note.none")}
                  </p>
                  <span class="shrink-0 text-[0.625rem] text-text-muted">{statusLabel()}</span>
                </div>
                <Show when={memoryState.knowledgeStats}>
                  {(stats) => (
                    <div class="mt-2 flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-[0.65rem] text-text-muted">
                      <span>
                        {t("gbrain.stats.pages")}{" "}
                        <b class="font-medium text-text-secondary">{stats().pages}</b>
                      </span>
                      <span>
                        {t("gbrain.stats.insights")}{" "}
                        <b class="font-medium text-text-secondary">{stats().insights}</b>
                      </span>
                      <span>
                        {t("gbrain.stats.timeline")}{" "}
                        <b class="font-medium text-text-secondary">{stats().timelineEntries}</b>
                      </span>
                      <span>
                        {t("gbrain.stats.suggestions")}{" "}
                        <b class="font-medium text-text-secondary">{stats().suggestions}</b>
                      </span>
                    </div>
                  )}
                </Show>
                <div class="mt-2 flex min-w-0 flex-wrap gap-1">
                  <Show
                    when={memoryState.enabled}
                    fallback={
                      <button
                        type="button"
                        disabled={busy() !== null}
                        class="rounded-sm border border-border/50 bg-bg-secondary/35 px-1.5 py-0.5 text-[0.625rem] text-text-muted transition hover:bg-ghost-hover hover:text-text-secondary disabled:cursor-not-allowed disabled:opacity-45"
                        onClick={turnOnGBrain}
                      >
                        {t("gbrain.action.turn_on")}
                      </button>
                    }
                  >
                    <button
                      type="button"
                      disabled={busy() !== null}
                      class="rounded-sm border border-border/50 bg-bg-secondary/35 px-1.5 py-0.5 text-[0.625rem] text-text-muted transition hover:bg-ghost-hover hover:text-text-secondary disabled:cursor-not-allowed disabled:opacity-45"
                      onClick={turnOffGBrain}
                    >
                      {t("gbrain.action.turn_off")}
                    </button>
                  </Show>
                  <button
                    type="button"
                    disabled={!memoryState.activePath || busy() !== null}
                    class="rounded-sm border border-border/50 bg-bg-secondary/35 px-1.5 py-0.5 text-[0.625rem] text-text-muted transition hover:bg-ghost-hover hover:text-text-secondary disabled:cursor-not-allowed disabled:opacity-45"
                    onClick={() => void rememberCurrent()}
                  >
                    {t("gbrain.capability.remember")}
                  </button>
                  <button
                    type="button"
                    disabled={busy() !== null}
                    class="rounded-sm border border-border/50 bg-bg-secondary/35 px-1.5 py-0.5 text-[0.625rem] text-text-muted transition hover:bg-ghost-hover hover:text-text-secondary disabled:cursor-not-allowed disabled:opacity-45"
                    onClick={() => void askForCurrentConnections()}
                  >
                    {t("gbrain.capability.connect")}
                  </button>
                  <button
                    type="button"
                    disabled={busy() !== null}
                    class="rounded-sm border border-border/50 bg-bg-secondary/35 px-1.5 py-0.5 text-[0.625rem] text-text-muted transition hover:bg-ghost-hover hover:text-text-secondary disabled:cursor-not-allowed disabled:opacity-45"
                    onClick={() => textareaRef?.focus()}
                  >
                    {t("gbrain.capability.ask")}
                  </button>
                </div>
                <Show when={memoryState.enabled && memoryState.heldMemory}>
                  {(held) => (
                    <div class="mt-2 flex min-w-0 items-center gap-1.5 rounded-sm border border-border/60 bg-bg-secondary/35 px-2 py-1.5">
                      <span class="shrink-0 text-[0.625rem] font-medium text-accent">
                        {t("gbrain.hold.label")}
                      </span>
                      <span class="min-w-0 flex-1 truncate text-[0.6875rem] text-text-secondary">
                        {held().title}
                      </span>
                      <button
                        type="button"
                        class="shrink-0 rounded-sm px-1 py-0.5 text-[0.625rem] text-text-muted transition hover:bg-ghost-hover hover:text-text-primary"
                        onClick={releaseHeldMemory}
                      >
                        {t("gbrain.hold.release")}
                      </button>
                    </div>
                  )}
                </Show>
              </div>
            </div>

            <div class="flex items-center gap-1.5">
              <button
                type="button"
                disabled={!memoryState.activePath || busy() !== null}
                class="inline-flex h-7 min-w-0 flex-1 items-center justify-center rounded-sm border border-border/70 bg-bg-secondary/40 px-2 text-[0.6875rem] text-text-secondary transition hover:bg-ghost-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-45"
                onClick={() => void rememberCurrent()}
              >
                {t("gbrain.action.remember")}
              </button>
              <button
                type="button"
                disabled={!vaultState.rootPath || busy() !== null}
                class="inline-flex h-7 min-w-0 flex-1 items-center justify-center rounded-sm border border-border/70 bg-bg-secondary/40 px-2 text-[0.6875rem] text-text-secondary transition hover:bg-ghost-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-45"
                onClick={() => void importVault()}
              >
                {t("gbrain.action.remember_all")}
              </button>
              <button
                type="button"
                disabled={!memoryState.activeSlug}
                class="flex h-7 w-8 shrink-0 items-center justify-center rounded-sm border border-border/70 bg-bg-secondary/40 text-text-muted transition hover:bg-ghost-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-45"
                title={t("gbrain.action.graph")}
                onClick={() => openTab("Graph", null, "graph")}
              >
                <GraphIcon size={13} />
              </button>
            </div>
          </section>

          <section class="space-y-1">
            <div class="flex h-6 items-center justify-between">
              <p class="text-[0.6875rem] font-medium text-text-secondary">
                {t("gbrain.section.related")}
              </p>
              <Show when={memoryState.loading}>
                <span class="text-[0.625rem] text-text-muted">{t("gbrain.memory.using")}</span>
              </Show>
            </div>
            <Show
              when={memoryState.related.length > 0}
              fallback={
                <p class="py-2 text-[0.75rem] text-text-muted">{t("gbrain.empty.related")}</p>
              }
            >
              <div class="space-y-0.5">
                <For each={memoryState.related}>
                  {(item) => (
                    <button
                      type="button"
                      class="group flex w-full min-w-0 items-center gap-2 rounded-sm p-1.5 text-left transition hover:bg-ghost-hover"
                      onClick={() => void useRelated(item.slug, item.title)}
                    >
                      <span class="size-1.5 shrink-0 rounded-full bg-text-muted/25 group-hover:bg-accent/70" />
                      <span class="min-w-0 flex-1">
                        <span class="block truncate text-[0.75rem] text-text-primary">
                          {item.title}
                        </span>
                        <span class="block truncate text-[0.625rem] text-text-muted">
                          {item.reason} · {item.score}
                        </span>
                      </span>
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </section>

          <section class="space-y-1">
            <div class="flex h-6 items-center justify-between">
              <p class="text-[0.6875rem] font-medium text-text-secondary">
                {t("gbrain.section.suggestions")}
              </p>
              <Show when={memoryState.suggestions.length > 0}>
                <span class="text-[0.625rem] text-accent">{memoryState.suggestions.length}</span>
              </Show>
            </div>
            <Show
              when={memoryState.suggestions.length > 0}
              fallback={
                <p class="py-2 text-[0.75rem] text-text-muted">{t("gbrain.empty.suggestions")}</p>
              }
            >
              <div class="space-y-1">
                <For each={memoryState.suggestions}>
                  {(item) => (
                    <div class="group rounded-sm p-1.5 transition hover:bg-ghost-hover">
                      <div class="flex min-w-0 items-start gap-2">
                        <span class="mt-1.5 size-1.5 shrink-0 rounded-full bg-accent/50" />
                        <div class="min-w-0 flex-1">
                          <div class="flex min-w-0 items-center justify-between gap-2">
                            <p class="truncate text-[0.6875rem] font-medium text-text-secondary">
                              {suggestionLabel(item.kind)}
                            </p>
                            <span class="shrink-0 text-[0.625rem] text-text-muted">
                              {Math.round(item.confidence * 100)}%
                            </span>
                          </div>
                          <p class="mt-0.5 line-clamp-2 text-xs/snug text-text-primary">
                            {item.preview}
                          </p>
                          <div class="mt-1.5 flex items-center gap-1.5">
                            <button
                              type="button"
                              disabled={busy() !== null}
                              class="rounded-sm px-1.5 py-0.5 text-[0.65rem] text-accent hover:bg-accent/12 disabled:cursor-not-allowed disabled:opacity-50"
                              onClick={() => void acceptSuggestion(item.id)}
                            >
                              {t("gbrain.action.accept")}
                            </button>
                            <button
                              type="button"
                              disabled={busy() !== null}
                              class="rounded-sm px-1.5 py-0.5 text-[0.65rem] text-text-muted hover:bg-bg-secondary hover:text-text-secondary disabled:cursor-not-allowed disabled:opacity-50"
                              onClick={() => void dismissSuggestion(item.id)}
                            >
                              {t("gbrain.action.dismiss")}
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </section>

          <Show when={status()}>
            {(message) => (
              <p class="rounded-sm border border-border/50 bg-bg-secondary/35 px-2 py-1.5 text-[0.6875rem] text-text-secondary">
                {message()}
              </p>
            )}
          </Show>
          <Show when={panelError() || memoryState.error}>
            {(message) => (
              <p class="rounded-sm border border-error-border bg-error-bg px-2 py-1.5 text-[0.6875rem] leading-relaxed text-error">
                {message()}
              </p>
            )}
          </Show>
        </div>
      </main>

      <footer class="relative shrink-0 focus-within:outline-none" data-kuku-ai-chat-composer>
        <div class="px-2 py-1.5 sm:px-2.5">
          <textarea
            ref={textareaRef}
            value={draft()}
            rows={1}
            placeholder={t("gbrain.ask.placeholder")}
            class="kuku-ai-composer-textarea min-h-18 w-full resize-none bg-transparent py-1 text-[0.8125rem] leading-normal text-text-primary outline-none selection:bg-ghost-selected placeholder:text-text-muted/70"
            onInput={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void askMemory(draft());
              }
            }}
          />
          <div class="mt-0.5 flex min-h-8 items-center justify-between gap-2 border-t border-border/50 pt-1.5">
            <div class="flex min-w-0 items-center gap-2.5">
              <button
                type="button"
                class="inline-flex min-h-7 min-w-0 items-center gap-1 rounded-sm px-1.5 py-1 text-[0.75rem] text-text-muted transition hover:bg-ghost-hover hover:text-text-secondary"
                classList={{
                  "text-accent":
                    memoryState.enabled &&
                    (memoryState.status === "using" ||
                      memoryState.status === "needsReview" ||
                      Boolean(memoryState.heldMemory)),
                }}
                title={t("gbrain.title")}
                onClick={() => void refreshMemoryContext()}
              >
                <BrainIcon size={12} class="shrink-0" />
                <span class="max-w-24 truncate">{statusLabel()}</span>
              </button>
            </div>
            <button
              type="button"
              disabled={!draft().trim() || busy() !== null}
              class="flex size-7 items-center justify-center rounded-sm text-text-secondary transition hover:bg-ghost-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent"
              title={t("gbrain.action.send_to_ai")}
              onClick={() => void askMemory(draft())}
            >
              <svg
                class="shrink-0"
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.75"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M12 19V5M5 12l7-7 7 7" />
              </svg>
            </button>
          </div>
        </div>
      </footer>
    </div>
  );
}
