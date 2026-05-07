// ── Graph Tab ──
//
// Full-width graph view rendered in the center tab area.
//
// SolidJS reactivity:
//   - `getGraphStore()` is a signal read — component re-renders when
//     the store is created/destroyed during plugin lifecycle
//   - Store properties (nodes, links, clusters, …) accessed lazily
//     inside JSX expressions for fine-grained tracking
//   - GraphCanvas handle stored in a signal for zoom control access

import { type JSX, createMemo, createSignal, For, lazy, onCleanup, Show, Suspense } from "solid-js";

import { t, tf } from "~/i18n";
import { getActiveTab, openTab } from "~/stores/files";

import GraphCanvas from "./graph_canvas_pixi";
import { getGraphStore } from "./graph_store";
import { graphViewMode, setGraphViewMode } from "./graph_view_mode";
import {
  clusterColor,
  getGraphSummary,
  type GraphCanvasHandle,
  type GraphNode,
} from "./graph_types";

// ── Helpers ──────────────────────────────────────────────────

function fileNameFromPath(path: string): string {
  return path.split("/").at(-1) ?? path;
}

function openGraphNode(node: GraphNode): void {
  openTab(fileNameFromPath(node.filePath), node.filePath, "editor");
}

const GraphCanvas3D = lazy(() => import("./graph_canvas_3d"));

// ── Component ────────────────────────────────────────────────

export default function GraphTab() {
  // Handle is stored for future toolbar integration (e.g. external zoom buttons).
  // Currently only `setHandle` is used as the onHandle callback.
  const [, setHandle] = createSignal<GraphCanvasHandle | null>(null);

  // ── Reactive derivations ────────────────────────────────
  //
  // `getGraphStore()` reads the module-level signal — tracked.
  // `summary()` reads store.state.nodes/links/clusters inside
  // `getGraphSummary`, so it re-computes only when those change.

  const store = () => getGraphStore();
  const summary = createMemo(() => getGraphSummary(store()?.state ?? null));

  // Track the currently active file for "locate current" feature
  const currentFilePath = createMemo(() => {
    const tab = getActiveTab();
    if (tab?.type === "editor" && tab.filePath) {
      return tab.filePath;
    }
    return null;
  });

  // ── Dynamic legend overflow ─────────────────────────────

  const clusters = createMemo(() => store()?.state.clusters ?? []);
  const [legendWidth, setLegendWidth] = createSignal(0);

  const visibleCount = createMemo(() => {
    const width = legendWidth();
    const all = clusters();
    if (width === 0 || all.length === 0) return all.length;

    const itemGap = 12; // gap-3
    const moreBadgeWidth = 72;
    let used = 0;

    for (let i = 0; i < all.length; i++) {
      const label = all[i].split("/").pop() ?? all[i];
      // Estimate: dot(10) + dot-text gap(6) + text(~7px per char @ 12px)
      const itemWidth = 16 + label.length * 7;
      const step = i > 0 ? itemGap + itemWidth : itemWidth;
      const remaining = all.length - (i + 1);
      const moreCost = remaining > 0 ? itemGap + moreBadgeWidth : 0;

      if (used + step + moreCost > width) return Math.max(1, i);
      used += step;
    }
    return all.length;
  });

  const hiddenCount = createMemo(() => clusters().length - visibleCount());

  function legendRef(el: HTMLDivElement): void {
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setLegendWidth(e.contentRect.width);
    });
    ro.observe(el);
    onCleanup(() => ro.disconnect());
  }

  return (
    <div class="flex h-full min-h-0 flex-col overflow-hidden bg-bg-primary">
      {/* ── Header ── */}
      <div class="flex items-center justify-between gap-4 border-b border-border/70 bg-bg-secondary/60 px-4 py-3">
        <div class="min-w-0 space-y-0.5">
          <p class="text-sm font-medium text-text-primary">{t("graph.title")}</p>
          <p class="truncate text-xs text-text-muted">{t("graph.tab.subtitle")}</p>
        </div>

        <div class="flex shrink-0 items-center gap-3 font-mono text-[0.6875rem] text-text-muted tabular-nums">
          <span>{tf("graph.tab.metric.nodes", { count: summary().nodeCount })}</span>
          <span aria-hidden="true" class="h-2.5 w-px bg-border" />
          <span>{tf("graph.tab.metric.links", { count: summary().linkCount })}</span>
          <span aria-hidden="true" class="h-2.5 w-px bg-border" />
          <span>{tf("graph.tab.metric.clusters", { count: summary().clusterCount })}</span>

          <Show when={summary().orphanCount > 0}>
            <span aria-hidden="true" class="h-2.5 w-px bg-border" />
            <span>
              {summary().orphanCount > 1
                ? tf("graph.tab.metric.orphan_other", { count: summary().orphanCount })
                : tf("graph.tab.metric.orphan_one", { count: summary().orphanCount })}
            </span>
          </Show>

          <div
            class="ml-1 flex items-center rounded-xs border border-border/70 bg-bg-primary/65 p-0.5 font-ui text-[0.6875rem] text-text-muted shadow-soft-1"
            role="group"
            aria-label={t("graph.tab.view_mode")}
          >
            <ModeBtn
              active={graphViewMode() === "2d"}
              title={t("graph.tab.view_2d")}
              onClick={() => setGraphViewMode("2d")}
            >
              2D
            </ModeBtn>
            <ModeBtn
              active={graphViewMode() === "3d"}
              title={t("graph.tab.view_3d")}
              onClick={() => setGraphViewMode("3d")}
            >
              3D
            </ModeBtn>
          </div>
        </div>
      </div>

      {/* ── Canvas ── */}
      <div class="flex min-h-0 flex-1">
        <Show
          when={graphViewMode() === "3d"}
          fallback={
            <GraphCanvas
              variant="full"
              currentFilePath={currentFilePath()}
              onNodeClick={openGraphNode}
              onHandle={setHandle}
            />
          }
        >
          <Suspense fallback={<GraphCanvas variant="full" currentFilePath={currentFilePath()} />}>
            <GraphCanvas3D
              variant="full"
              currentFilePath={currentFilePath()}
              onNodeClick={openGraphNode}
              onHandle={setHandle}
            />
          </Suspense>
        </Show>
      </div>

      {/* ── Legend (clusters — dynamically overflows based on width) ── */}
      <Show when={summary().clusterCount > 0}>
        <div
          ref={legendRef}
          class="flex items-center gap-3 overflow-hidden border-t border-border/70 bg-bg-secondary/40 px-4 py-2"
        >
          <For each={clusters().slice(0, visibleCount())}>
            {(cluster, i) => (
              <div class="flex shrink-0 items-center gap-1.5 text-[0.75rem] text-text-secondary">
                <span
                  class="inline-block size-2.5 shrink-0 rounded-full ring-1 ring-border"
                  style={{ background: clusterColor(i()) }}
                />
                <span class="whitespace-nowrap">{cluster.split("/").pop() ?? cluster}</span>
              </div>
            )}
          </For>
          <Show when={hiddenCount() > 0}>
            <span class="shrink-0 font-mono text-[0.6875rem] text-text-muted tabular-nums">
              {tf("graph.tab.more", { count: hiddenCount() })}
            </span>
          </Show>
        </div>
      </Show>
    </div>
  );
}

function ModeBtn(props: {
  active: boolean;
  title: string;
  onClick: () => void;
  children: JSX.Element;
}): JSX.Element {
  return (
    <button
      type="button"
      title={props.title}
      class="h-6 min-w-8 cursor-pointer rounded-xs border-none px-2 font-medium transition-colors duration-100 hover:bg-ghost-hover hover:text-text-primary"
      classList={{
        "bg-element-selected text-text-primary shadow-soft-1": props.active,
        "bg-transparent text-text-muted": !props.active,
      }}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}
