import { For, Show, createSignal, onMount } from "solid-js";

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
                <div
                  role="button"
                  tabIndex={0}
                  class="relative w-full cursor-pointer overflow-hidden rounded-sm border border-border bg-bg-primary text-left transition-colors hover:bg-bg-tertiary"
                  onClick={() => void copyWidget(widget.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") void copyWidget(widget.id);
                  }}
                >
                  <Show when={copied() === widget.id}>
                    <div class="pointer-events-none absolute top-2 right-2 z-10 rounded-sm border border-text-primary bg-text-primary px-2 py-1 text-[0.6875rem] font-semibold text-bg-primary shadow-xl">
                      {t("widget.panel.copied")}
                    </div>
                  </Show>
                  <div class="flex items-center justify-between border-b border-border/60 px-2 py-1.5">
                    <span class="truncate font-medium text-text-primary">{widget.name}</span>
                    <span class="ml-2 shrink-0 text-[0.6875rem] text-text-muted">{widget.id}</span>
                  </div>
                  <iframe
                    {...widgetIframeDragGuardAttrs()}
                    title={widget.name}
                    sandbox={WIDGET_IFRAME_SANDBOX}
                    srcdoc={buildWidgetIframeDocument(widget)}
                    class="pointer-events-none block h-32 w-full border-0 bg-white"
                  />
                </div>
              )}
            </For>
          </div>
        </Show>
      </Show>
    </div>
  );
}
