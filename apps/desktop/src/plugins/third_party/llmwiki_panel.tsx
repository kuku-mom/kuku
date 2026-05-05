import { createEffect, createSignal, For, Show, type JSX } from "solid-js";

import { FileIcon, GraphIcon, SearchIcon, WikiBookIcon } from "~/components/icons";
import { t, tf } from "~/i18n";
import { sendMessage, switchMode } from "~/plugins/builtin/ai_chat/chat_store";
import { getActiveTab } from "~/stores/files";
import { openRightPanelView } from "~/stores/layout";

import {
  analyzeWiki,
  ingestActiveNote,
  initWiki,
  lintWiki,
  queryWikiContext,
  refreshWiki,
  searchWiki,
  titleFromPath,
  wikiState,
} from "./llmwiki_store";

type BusyAction = "init" | "ingest" | "ask" | "search" | "lint" | "deep" | null;

function StatusDot(): JSX.Element {
  return (
    <span
      class="size-1.5 shrink-0 rounded-full bg-text-muted/30"
      classList={{ "bg-accent/70": wikiState.initialized }}
      aria-hidden="true"
    />
  );
}

export default function LlmWikiPanel(): JSX.Element {
  let textareaRef: HTMLTextAreaElement | undefined;
  const [draft, setDraft] = createSignal("");
  const [busy, setBusy] = createSignal<BusyAction>(null);
  const [status, setStatus] = createSignal<string | null>(null);
  const [lintResult, setLintResult] = createSignal<string | null>(null);

  createEffect(() => {
    void refreshWiki();
  });

  async function initialize(): Promise<void> {
    if (busy()) return;
    if (wikiState.initialized) {
      setStatus(t("llmwiki.status.already_initialized"));
      return;
    }
    setBusy("init");
    setStatus(null);
    await initWiki();
    setStatus(wikiState.error ? null : t("llmwiki.status.initialized"));
    setBusy(null);
  }

  async function ingestCurrent(): Promise<void> {
    if (busy()) return;
    setBusy("ingest");
    setStatus(null);
    const ok = await ingestActiveNote();
    setStatus(ok ? t("llmwiki.status.ingested") : t("llmwiki.error.open_note_first"));
    setBusy(null);
  }

  async function askWiki(request: string): Promise<void> {
    const query = request.trim();
    if (!query || busy()) return;
    setBusy("ask");
    setStatus(null);
    try {
      const context = await queryWikiContext(query);
      await switchMode("agent");
      openRightPanelView("ai-chat.panel");
      const sent = await sendMessage(
        [
          "Use the user's LLM Wiki as a persistent compiled wiki layer.",
          "If the answer identifies durable updates for log.md, SCHEMA.md, sources, concepts, or synthesis pages, perform those updates with wiki_write_page instead of only telling the user to do it.",
          "Prefer small, reviewable wiki writes and preserve existing content when updating a page.",
          "",
          context,
          "",
          `User question: ${query}`,
        ].join("\n"),
        {
          includeSelectedText: false,
          memoryMode: "off",
        },
      );
      if (!sent) setStatus(t("llmwiki.error.ai_unavailable"));
    } finally {
      setBusy(null);
    }
  }

  async function runSearch(): Promise<void> {
    if (busy()) return;
    setBusy("search");
    await searchWiki(draft());
    setBusy(null);
  }

  async function runLint(): Promise<void> {
    if (busy()) return;
    setBusy("lint");
    setLintResult(await lintWiki());
    setBusy(null);
  }

  async function runDeepScan(): Promise<void> {
    if (busy()) return;
    setBusy("deep");
    await analyzeWiki();
    setStatus(t("llmwiki.status.deep_scanned"));
    setBusy(null);
  }

  async function askSynthesis(path: string, title: string): Promise<void> {
    await askWiki(tf("llmwiki.prompt.synthesize", { path, title }));
  }

  const activeTitle = () => titleFromPath(getActiveTab()?.filePath ?? null);

  return (
    <div class="flex h-full min-h-0 flex-col bg-bg-primary">
      <header class="flex h-10 shrink-0 items-center justify-between border-b border-border bg-bg-primary px-3">
        <div class="flex min-w-0 items-center gap-2">
          <StatusDot />
          <span class="truncate text-[0.6875rem] font-medium tracking-wide text-text-muted">
            {t("llmwiki.title")}
          </span>
        </div>
      </header>

      <main class="min-h-0 flex-1 overflow-auto">
        <div class="space-y-4 p-3">
          <section class="space-y-2.5">
            <div class="flex min-w-0 items-start gap-2">
              <div class="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-sm border border-border/60 bg-bg-secondary/60 text-text-muted">
                <WikiBookIcon size={14} />
              </div>
              <div class="min-w-0 flex-1">
                <div class="flex min-w-0 items-center justify-between gap-2">
                  <p class="truncate text-[0.8125rem] font-medium text-text-primary">
                    {activeTitle() || t("llmwiki.note.none")}
                  </p>
                  <span class="shrink-0 text-[0.625rem] text-text-muted">
                    {wikiState.initialized ? t("llmwiki.status.ready") : t("llmwiki.status.off")}
                  </span>
                </div>
                <Show when={wikiState.status}>
                  {(stats) => (
                    <>
                      <div class="mt-2 flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-[0.65rem] text-text-muted">
                        <span>
                          {t("llmwiki.stats.pages")}{" "}
                          <b class="font-medium text-text-secondary">{stats().pages}</b>
                        </span>
                        <span>
                          {t("llmwiki.stats.sources")}{" "}
                          <b class="font-medium text-text-secondary">{stats().sources}</b>
                        </span>
                        <span>
                          {t("llmwiki.stats.links")}{" "}
                          <b class="font-medium text-text-secondary">{stats().links}</b>
                        </span>
                        <span>
                          {t("llmwiki.stats.orphans")}{" "}
                          <b class="font-medium text-text-secondary">{stats().orphans}</b>
                        </span>
                        <span>
                          {t("llmwiki.stats.concepts")}{" "}
                          <b class="font-medium text-text-secondary">{stats().concepts ?? 0}</b>
                        </span>
                      </div>
                    </>
                  )}
                </Show>
              </div>
            </div>

            <div class="flex items-center gap-1.5">
              <button
                type="button"
                disabled={wikiState.initialized || busy() !== null}
                class="inline-flex h-7 min-w-0 flex-1 items-center justify-center rounded-sm border border-border/70 bg-bg-secondary/40 px-2 text-[0.6875rem] text-text-secondary transition hover:bg-ghost-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-45"
                onClick={() => void initialize()}
              >
                {wikiState.initialized ? t("llmwiki.action.created") : t("llmwiki.action.init")}
              </button>
              <button
                type="button"
                disabled={!getActiveTab()?.filePath || busy() !== null}
                class="inline-flex h-7 min-w-0 flex-1 items-center justify-center rounded-sm border border-border/70 bg-bg-secondary/40 px-2 text-[0.6875rem] text-text-secondary transition hover:bg-ghost-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-45"
                onClick={() => void ingestCurrent()}
              >
                {t("llmwiki.action.ingest")}
              </button>
              <button
                type="button"
                disabled={busy() !== null}
                class="flex h-7 w-8 shrink-0 items-center justify-center rounded-sm border border-border/70 bg-bg-secondary/40 text-text-muted transition hover:bg-ghost-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-45"
                title={t("llmwiki.action.lint")}
                onClick={() => void runLint()}
              >
                <GraphIcon size={13} />
              </button>
            </div>
            <button
              type="button"
              disabled={busy() !== null}
              class="inline-flex h-7 w-full min-w-0 items-center justify-center rounded-sm border border-border/70 bg-bg-secondary/40 px-2 text-[0.6875rem] text-text-secondary transition hover:bg-ghost-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-45"
              onClick={() => void runDeepScan()}
            >
              {t("llmwiki.action.deep_scan")}
            </button>
          </section>

          <section class="space-y-1">
            <div class="flex h-6 items-center justify-between">
              <p class="text-[0.6875rem] font-medium text-text-secondary">
                {t("llmwiki.section.review")}
              </p>
              <Show when={wikiState.review?.synthesisCandidates.length}>
                <span class="text-[0.625rem] text-accent">
                  {wikiState.review?.synthesisCandidates.length}
                </span>
              </Show>
            </div>
            <Show
              when={wikiState.review}
              fallback={
                <p class="py-2 text-[0.75rem] text-text-muted">{t("llmwiki.empty.review")}</p>
              }
            >
              {(review) => (
                <div class="space-y-2">
                  <div class="flex min-w-0 flex-wrap gap-1">
                    <For each={review().topConcepts.slice(0, 5)}>
                      {(item) => (
                        <button
                          type="button"
                          class="rounded-sm border border-border/50 bg-bg-secondary/35 px-1.5 py-0.5 text-[0.625rem] text-text-muted transition hover:bg-ghost-hover hover:text-text-secondary"
                          onClick={() =>
                            void askWiki(tf("llmwiki.prompt.concept", { concept: item.concept }))
                          }
                        >
                          {item.concept} · {item.count}
                        </button>
                      )}
                    </For>
                  </div>
                  <Show when={review().synthesisCandidates.length > 0}>
                    <div class="space-y-0.5">
                      <For each={review().synthesisCandidates.slice(0, 3)}>
                        {(item) => (
                          <button
                            type="button"
                            class="group flex w-full min-w-0 items-center gap-2 rounded-sm p-1.5 text-left transition hover:bg-ghost-hover"
                            onClick={() => void askSynthesis(item.targetPath, item.title)}
                          >
                            <span class="size-1.5 shrink-0 rounded-full bg-accent/50" />
                            <span class="min-w-0 flex-1">
                              <span class="block truncate text-[0.75rem] text-text-primary">
                                {item.title}
                              </span>
                              <span class="block truncate text-[0.625rem] text-text-muted">
                                {item.targetPath}
                              </span>
                            </span>
                          </button>
                        )}
                      </For>
                    </div>
                  </Show>
                  <Show when={review().questions.length > 0}>
                    <p class="line-clamp-2 text-[0.6875rem] leading-snug text-text-muted">
                      {review().questions[0]}
                    </p>
                  </Show>
                </div>
              )}
            </Show>
          </section>

          <Show when={wikiState.initialized && wikiState.pages.length === 0}>
            <p class="rounded-sm border border-border/50 bg-bg-secondary/35 px-2 py-1.5 text-[0.6875rem] leading-relaxed text-text-secondary">
              {t("llmwiki.status.created_empty")}
            </p>
          </Show>

          <section class="space-y-1">
            <div class="flex h-6 items-center justify-between">
              <p class="text-[0.6875rem] font-medium text-text-secondary">
                {t("llmwiki.section.matches")}
              </p>
              <Show when={wikiState.loading}>
                <span class="text-[0.625rem] text-text-muted">{t("llmwiki.status.working")}</span>
              </Show>
            </div>
            <Show
              when={wikiState.matches.length > 0}
              fallback={
                <p class="py-2 text-[0.75rem] text-text-muted">{t("llmwiki.empty.matches")}</p>
              }
            >
              <div class="space-y-0.5">
                <For each={wikiState.matches}>
                  {(item) => (
                    <button
                      type="button"
                      class="group flex w-full min-w-0 items-center gap-2 rounded-sm p-1.5 text-left transition hover:bg-ghost-hover"
                      onClick={() =>
                        void askWiki(
                          tf("llmwiki.prompt.use_page", { title: item.title, path: item.path }),
                        )
                      }
                    >
                      <span class="size-1.5 shrink-0 rounded-full bg-text-muted/25 group-hover:bg-accent/70" />
                      <span class="min-w-0 flex-1">
                        <span class="block truncate text-[0.75rem] text-text-primary">
                          {item.title}
                        </span>
                        <span class="block truncate text-[0.625rem] text-text-muted">
                          {item.path} · {item.score}
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
                {t("llmwiki.section.recent")}
              </p>
              <span class="text-[0.625rem] text-text-muted">{wikiState.pages.length}</span>
            </div>
            <Show
              when={wikiState.pages.length > 0}
              fallback={
                <p class="py-2 text-[0.75rem] text-text-muted">{t("llmwiki.empty.pages")}</p>
              }
            >
              <div class="space-y-0.5">
                <For each={wikiState.pages.slice(0, 6)}>
                  {(item) => (
                    <button
                      type="button"
                      class="flex w-full min-w-0 items-center gap-2 rounded-sm p-1.5 text-left transition hover:bg-ghost-hover"
                      onClick={() =>
                        void askWiki(
                          tf("llmwiki.prompt.use_page", { title: item.title, path: item.path }),
                        )
                      }
                    >
                      <FileIcon size={12} class="shrink-0 text-text-muted" />
                      <span class="min-w-0 flex-1 truncate text-[0.75rem] text-text-primary">
                        {item.title}
                      </span>
                    </button>
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
          <Show when={lintResult()}>
            {(message) => (
              <pre class="max-h-32 overflow-auto rounded-sm border border-border/50 bg-bg-secondary/35 px-2 py-1.5 text-[0.625rem] text-text-muted">
                {message()}
              </pre>
            )}
          </Show>
          <Show when={wikiState.error}>
            {(message) => (
              <p class="rounded-sm border border-error-border bg-error-bg px-2 py-1.5 text-[0.6875rem] leading-relaxed text-error">
                {message() === "open_vault_first" ? t("llmwiki.error.open_vault_first") : message()}
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
            placeholder={t("llmwiki.ask.placeholder")}
            class="kuku-ai-composer-textarea min-h-18 w-full resize-none bg-transparent py-1 text-[0.8125rem] leading-normal text-text-primary outline-none selection:bg-ghost-selected placeholder:text-text-muted/70"
            onInput={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void askWiki(draft());
              }
            }}
          />
          <div class="mt-0.5 flex min-h-8 items-center justify-between gap-2 border-t border-border/50 pt-1.5">
            <button
              type="button"
              class="inline-flex min-h-7 min-w-0 items-center gap-1 rounded-sm px-1.5 py-1 text-[0.75rem] text-text-muted transition hover:bg-ghost-hover hover:text-text-secondary"
              onClick={() => void runSearch()}
            >
              <SearchIcon size={12} class="shrink-0" />
              <span class="max-w-24 truncate">{t("llmwiki.action.search")}</span>
            </button>
            <button
              type="button"
              disabled={!draft().trim() || busy() !== null}
              class="flex size-7 items-center justify-center rounded-sm text-text-secondary transition hover:bg-ghost-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent"
              title={t("llmwiki.action.ask")}
              onClick={() => void askWiki(draft())}
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
