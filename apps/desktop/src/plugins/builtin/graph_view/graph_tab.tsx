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

import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";

import { getActiveTab, openTab } from "~/stores/files";

import GraphCanvas from "./graph_canvas";
import { getGraphStore } from "./graph_store";
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
    const moreBadgeWidth = 70;
    let used = 0;

    for (let i = 0; i < all.length; i++) {
      const label = all[i].split("/").pop() ?? all[i];
      // Estimate: dot(8) + dot-text gap(6) + text(~6.5px per char)
      const itemWidth = 14 + label.length * 6.5;
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
      <div class="flex items-center justify-between border-b border-border/70 bg-bg-secondary/60 px-4 py-3">
        <div class="space-y-0.5">
          <p class="text-sm font-medium text-text-primary">Graph</p>
          <p class="text-xs text-text-muted">Visualize wikilink connections across the vault.</p>
        </div>

        <div class="flex items-center gap-3 text-[0.6875rem] text-text-muted">
          <span>{summary().nodeCount} nodes</span>
          <span>·</span>
          <span>{summary().linkCount} links</span>
          <span>·</span>
          <span>{summary().clusterCount} clusters</span>

          <Show when={summary().orphanCount > 0}>
            <span>·</span>
            <span class="text-text-muted/70">
              {summary().orphanCount} orphan{summary().orphanCount > 1 ? "s" : ""}
            </span>
          </Show>
        </div>
      </div>

      {/* ── Canvas ── */}
      <div class="flex min-h-0 flex-1">
        <GraphCanvas
          variant="full"
          currentFilePath={currentFilePath()}
          onNodeClick={openGraphNode}
          onHandle={setHandle}
        />
      </div>

      {/* ── Legend (clusters — dynamically overflows based on width) ── */}
      <Show when={summary().clusterCount > 0}>
        <div
          ref={legendRef}
          class="flex items-center gap-3 overflow-hidden border-t border-border/70 bg-bg-secondary/40 px-4 py-2"
        >
          <For each={clusters().slice(0, visibleCount())}>
            {(cluster, i) => (
              <div class="flex shrink-0 items-center gap-1.5 text-[0.6875rem] text-text-muted">
                <span
                  class="inline-block size-2 rounded-full"
                  style={{ background: clusterColor(i()) }}
                />
                <span class="whitespace-nowrap">{cluster.split("/").pop() ?? cluster}</span>
              </div>
            )}
          </For>
          <Show when={hiddenCount() > 0}>
            <span class="shrink-0 text-[0.6875rem] text-text-muted">+{hiddenCount()} more</span>
          </Show>
        </div>
      </Show>
    </div>
  );
}
