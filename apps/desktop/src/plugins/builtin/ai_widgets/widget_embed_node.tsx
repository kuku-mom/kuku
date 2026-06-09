import { Show, createMemo, createResource } from "solid-js";
import type { SolidNodeViewProps } from "prosekit/solid";

import { WIDGET_IFRAME_SANDBOX, buildWidgetIframeDocument } from "./iframe_document";
import { createWidgetProjectStore } from "./project_store";
import { normalizeKukuWidgetAttrs } from "./widget_markdown";

const store = createWidgetProjectStore();

function WidgetEmbedNode(props: SolidNodeViewProps) {
  const attrs = createMemo(
    () => normalizeKukuWidgetAttrs(props.node.attrs) ?? { id: "", height: 320 },
  );
  const [project] = createResource(
    () => attrs().id,
    async (id) => {
      if (!id) return null;
      return store.read(id);
    },
  );
  const srcdoc = createMemo(() => {
    const current = project();
    return current ? buildWidgetIframeDocument(current) : "";
  });

  return (
    <section
      contentEditable={false}
      data-kuku-widget-node=""
      data-widget-id={attrs().id}
      class="my-4 overflow-hidden rounded-sm border border-border/70 bg-bg-primary"
    >
      <div class="flex min-w-0 items-center justify-between border-b border-border/60 px-3 py-2 text-xs">
        <span class="min-w-0 truncate font-medium text-text-secondary">
          {project()?.name || attrs().id || "Widget"}
        </span>
        <span class="ml-3 shrink-0 text-text-muted">widget</span>
      </div>
      <Show
        when={!project.loading && !project.error && project()}
        fallback={
          <div
            class="flex items-center px-3 text-sm text-text-muted"
            style={{ height: `${attrs().height}px` }}
          >
            {project.error ? `Widget not found: ${attrs().id}` : "Loading widget..."}
          </div>
        }
      >
        <iframe
          title={project()?.name ?? attrs().id}
          sandbox={WIDGET_IFRAME_SANDBOX}
          srcdoc={srcdoc()}
          class="block w-full border-0 bg-white"
          style={{ height: `${attrs().height}px` }}
        />
      </Show>
    </section>
  );
}

function stopWidgetNodeEvent(event: Event): boolean {
  return event.target instanceof HTMLIFrameElement;
}

export { WidgetEmbedNode, stopWidgetNodeEvent };
