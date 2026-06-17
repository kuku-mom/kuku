import { For, Show, createSignal, onMount } from "solid-js";

import { TrashIcon } from "~/components/icons";
import { t } from "~/i18n";

import { WIDGET_IFRAME_SANDBOX, buildWidgetIframeDocument } from "./iframe_document";
import { createWidgetProjectStore } from "./project_store";
import type { WidgetProject } from "./types";
import { writeWidgetEmbedToClipboard } from "./widget_clipboard";
import { widgetIframeDragGuardAttrs } from "./widget_iframe_drag_guard";

const store = createWidgetProjectStore();

export default function WidgetPanel() {
  const [widgets, setWidgets] = createSignal<WidgetProject[]>([]);
  const [copied, setCopied] = createSignal<string | null>(null);
  const [confirmDelete, setConfirmDelete] = createSignal<string | null>(null);
  const [deleteFailed, setDeleteFailed] = createSignal<string | null>(null);
  const [deleting, setDeleting] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(true);

  onMount(() => {
    void (async () => {
      try {
        const summaries = await store.list();
        setWidgets(await Promise.all(summaries.map((widget) => store.read(widget.id))));
      } catch {
        setWidgets([]);
      } finally {
        setLoading(false);
      }
    })();
  });

  async function copyWidget(id: string): Promise<void> {
    try {
      await writeWidgetEmbedToClipboard(id);
    } catch {
      return;
    }
    setCopied(id);
    window.setTimeout(() => setCopied((current) => (current === id ? null : current)), 1400);
  }

  async function deleteWidget(widget: WidgetProject): Promise<void> {
    if (deleting()) return;
    setDeleteFailed(null);

    if (confirmDelete() !== widget.id) {
      setConfirmDelete(widget.id);
      window.setTimeout(
        () => setConfirmDelete((current) => (current === widget.id ? null : current)),
        2000,
      );
      return;
    }

    setDeleting(widget.id);
    try {
      await store.delete(widget.id);
      setWidgets((items) => items.filter((item) => item.id !== widget.id));
      setCopied((current) => (current === widget.id ? null : current));
      setConfirmDelete(null);
    } catch {
      setDeleteFailed(widget.id);
    } finally {
      setDeleting(null);
    }
  }

  return (
    <div class="flex h-full flex-col overflow-y-auto p-2 text-xs">
      <Show
        when={!loading()}
        fallback={<p class="p-2 text-text-muted">{t("widget.panel.loading")}</p>}
      >
        <Show
          when={widgets().length > 0}
          fallback={<p class="p-2 text-text-muted">{t("widget.panel.empty")}</p>}
        >
          <div class="space-y-2">
            <For each={widgets()}>
              {(widget) => (
                <div class="relative w-full overflow-hidden rounded-sm border border-border bg-bg-primary">
                  <Show when={copied() === widget.id}>
                    <div class="pointer-events-none absolute top-2 right-2 z-10 rounded-sm border border-text-primary bg-text-primary px-2 py-1 text-[0.6875rem] font-semibold text-bg-primary shadow-xl">
                      {t("widget.panel.copied")}
                    </div>
                  </Show>
                  <Show when={deleteFailed() === widget.id}>
                    <div class="pointer-events-none absolute top-2 right-2 z-10 rounded-sm border border-error-border bg-error-bg px-2 py-1 text-[0.6875rem] font-semibold text-error shadow-xl">
                      {t("widget.panel.delete_failed")}
                    </div>
                  </Show>
                  <div class="flex items-center justify-between border-b border-border/60 px-2 py-1.5">
                    <button
                      type="button"
                      class="min-w-0 truncate text-left font-medium text-text-primary"
                      onClick={() => void copyWidget(widget.id)}
                    >
                      {widget.name}
                    </button>
                    <div class="ml-2 flex shrink-0 items-center gap-1">
                      <span class="max-w-24 truncate text-[0.6875rem] text-text-muted">
                        {widget.id}
                      </span>
                      <button
                        type="button"
                        title={t("widget.panel.delete")}
                        aria-label={t("widget.panel.delete")}
                        disabled={deleting() === widget.id}
                        class="inline-flex h-6 shrink-0 items-center justify-center rounded-sm border border-transparent px-1.5 text-text-muted transition hover:border-error-border hover:bg-error-bg hover:text-error disabled:cursor-not-allowed disabled:opacity-50"
                        onClick={() => void deleteWidget(widget)}
                      >
                        <Show when={confirmDelete() === widget.id} fallback={<TrashIcon />}>
                          <span class="text-[0.6875rem] font-medium">
                            {t("widget.panel.delete_confirm")}
                          </span>
                        </Show>
                      </button>
                    </div>
                  </div>
                  <div class="relative transition hover:bg-bg-tertiary">
                    <iframe
                      {...widgetIframeDragGuardAttrs()}
                      title={widget.name}
                      sandbox={WIDGET_IFRAME_SANDBOX}
                      srcdoc={buildWidgetIframeDocument(widget)}
                      class="pointer-events-none block h-32 w-full border-0 bg-white"
                    />
                    <button
                      type="button"
                      aria-label={`${t("widget.panel.copy")} ${widget.name}`}
                      class="absolute inset-0 block w-full cursor-pointer bg-transparent"
                      onClick={() => void copyWidget(widget.id)}
                    />
                  </div>
                </div>
              )}
            </For>
          </div>
        </Show>
      </Show>
    </div>
  );
}
