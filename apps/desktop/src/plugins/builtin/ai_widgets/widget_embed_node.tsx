import { Show, createMemo, createResource, createSignal, onCleanup } from "solid-js";
import type { SolidNodeViewProps } from "prosekit/solid";

import { WIDGET_IFRAME_SANDBOX, buildWidgetIframeDocument } from "./iframe_document";
import { createWidgetProjectStore } from "./project_store";
import { getWidgetResizeHeight, shouldStopWidgetNodeEventTarget } from "./widget_resize";
import {
  KUKU_WIDGET_LANGUAGE,
  normalizeKukuWidgetAttrs,
  normalizeKukuWidgetHeight,
} from "./widget_markdown";
import { widgetIframeDragGuardAttrs } from "./widget_iframe_drag_guard";

const store = createWidgetProjectStore();

function WidgetEmbedNode(props: SolidNodeViewProps) {
  let teardownResize: (() => void) | null = null;

  const attrs = createMemo(
    () => normalizeKukuWidgetAttrs(props.node.attrs) ?? { id: "", height: 320 },
  );
  const [draftHeight, setDraftHeight] = createSignal<number | null>(null);
  const displayHeight = createMemo(() => draftHeight() ?? attrs().height);
  const isResizing = createMemo(() => draftHeight() !== null);
  const sourceFence = createMemo(
    () => `\`\`\`${KUKU_WIDGET_LANGUAGE}\nid: ${attrs().id}\nheight: ${displayHeight()}\n\`\`\``,
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
  const fallbackMessage = createMemo(() => {
    const id = attrs().id;
    if (!id) return "Widget not found";
    if (project.error || (!project.loading && project() == null)) {
      return `Widget not found: ${id}`;
    }
    return "Loading widget...";
  });

  onCleanup(() => teardownResize?.());

  function commitHeight(height: number): void {
    const normalizedHeight = normalizeKukuWidgetHeight(height);
    const current = attrs();
    if (!current.id || normalizedHeight === current.height) return;

    props.setAttrs({
      ...props.node.attrs,
      id: current.id,
      height: normalizedHeight,
    });
  }

  function onResizePointerDown(event: PointerEvent): void {
    event.preventDefault();
    event.stopPropagation();
    teardownResize?.();

    const target = event.currentTarget as HTMLElement | null;
    target?.setPointerCapture?.(event.pointerId);

    const startY = event.clientY;
    const startHeight = displayHeight();
    let nextHeight = startHeight;
    setDraftHeight(startHeight);

    const previousUserSelect = document.body.style.userSelect;
    const previousCursor = document.body.style.cursor;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "row-resize";

    function onPointerMove(moveEvent: PointerEvent): void {
      moveEvent.preventDefault();
      nextHeight = getWidgetResizeHeight(startHeight, startY, moveEvent.clientY);
      setDraftHeight(nextHeight);
    }

    function cleanup(): void {
      try {
        target?.releasePointerCapture?.(event.pointerId);
      } catch {
        // Pointer capture may already be released by the browser on cancel/unmount.
      }
      document.body.style.userSelect = previousUserSelect;
      document.body.style.cursor = previousCursor;
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerup", cleanup);
      document.removeEventListener("pointercancel", cleanup);
      teardownResize = null;
      commitHeight(nextHeight);
      setDraftHeight(null);
    }

    teardownResize = cleanup;
    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", cleanup);
    document.addEventListener("pointercancel", cleanup);
  }

  return (
    <section
      contentEditable={false}
      data-kuku-widget-node=""
      data-resizing={isResizing() ? "" : undefined}
      data-widget-id={attrs().id}
      class="overflow-hidden rounded-sm border border-border/70 bg-bg-primary"
    >
      <Show when={!props.selected} fallback={<WidgetSourceFence source={sourceFence()} />}>
        <Show
          when={!project.loading && !project.error && project()}
          fallback={
            <div
              class="flex items-center px-3 text-sm text-text-muted"
              style={{ height: `${displayHeight()}px` }}
            >
              {fallbackMessage()}
            </div>
          }
        >
          <iframe
            {...widgetIframeDragGuardAttrs()}
            title={project()?.name ?? attrs().id}
            sandbox={WIDGET_IFRAME_SANDBOX}
            srcdoc={srcdoc()}
            class="block w-full border-0 bg-white"
            classList={{ "pointer-events-none": isResizing() }}
            style={{ height: `${displayHeight()}px` }}
          />
        </Show>
      </Show>
      <Show when={!props.selected}>
        <div class="relative h-3 shrink-0 border-t border-border/60 bg-bg-secondary/40">
          <div
            class="kuku-resize-grip kuku-resize-grip--row"
            data-active={isResizing() ? "" : undefined}
            aria-hidden="true"
          />
          <button
            aria-label="Resize widget"
            title="Resize widget"
            type="button"
            data-kuku-widget-resize-handle=""
            onPointerDown={onResizePointerDown}
            class="relative z-10 flex size-full cursor-row-resize items-center justify-center transition-colors hover:bg-bg-secondary/70"
          >
            <span class="h-px w-8 rounded-full bg-border" aria-hidden="true" />
          </button>
        </div>
      </Show>
    </section>
  );
}

function WidgetSourceFence(props: { source: string }) {
  return (
    <pre
      data-kuku-widget-source=""
      class="m-0 max-w-full overflow-x-auto bg-bg-secondary p-0! text-xs/relaxed text-text-primary"
    >
      <code data-kuku-widget-source-code="" class="m-0 block p-0!">
        {props.source}
      </code>
    </pre>
  );
}

function stopWidgetNodeEvent(event: Event): boolean {
  return shouldStopWidgetNodeEventTarget(event.target);
}

export { WidgetEmbedNode, stopWidgetNodeEvent };
