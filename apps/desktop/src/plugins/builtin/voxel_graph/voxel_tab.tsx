// ── Agent World Tab ──
//
// Full center-tab view for the agent world renderer.

import { createMemo, Show } from "solid-js";

import { t, tf } from "~/i18n";
import { getGraphSummary, type GraphNode } from "~/plugins/builtin/graph_view/graph_types";
import { getActiveTab, openTab } from "~/stores/files";

import VoxelCanvas from "./voxel_canvas";
import { getVoxelVisibleStats } from "./voxel_layout";
import { getVoxelGraphStore } from "./voxel_store";

function fileNameFromPath(path: string): string {
  return path.split("/").at(-1) ?? path;
}

function openGraphNode(node: GraphNode): void {
  openTab(fileNameFromPath(node.filePath), node.filePath, "editor");
}

export default function VoxelGraphTab() {
  const store = () => getVoxelGraphStore();
  const summary = createMemo(() => getGraphSummary(store()?.state ?? null));
  const currentFilePath = createMemo(() => {
    const tab = getActiveTab();
    if (tab?.type === "voxel-graph") {
      return tab.state?.focusFilePath ?? null;
    }
    return tab?.type === "editor" && tab.filePath ? tab.filePath : null;
  });
  const visibleStats = createMemo(() => getVoxelVisibleStats(store()?.state ?? null));

  return (
    <div class="flex h-full min-h-0 flex-col overflow-hidden bg-bg-primary">
      <div class="flex items-center justify-between gap-4 border-b border-border/70 bg-bg-secondary/60 px-4 py-3">
        <div class="min-w-0 space-y-0.5">
          <p class="text-sm font-medium text-text-primary">{t("voxel_graph.title")}</p>
          <p class="truncate text-xs text-text-muted">{t("voxel_graph.subtitle")}</p>
        </div>

        <div class="flex shrink-0 items-center gap-3 font-mono text-[0.6875rem] text-text-muted tabular-nums">
          <span>
            {visibleStats().capped
              ? tf("voxel_graph.metric.visible_of_total", {
                  nodes: visibleStats().nodes,
                  totalNodes: visibleStats().totalNodes,
                  links: visibleStats().links,
                  totalLinks: visibleStats().totalLinks,
                })
              : tf("voxel_graph.metric.visible", {
                  nodes: visibleStats().nodes,
                  links: visibleStats().links,
                })}
          </span>
          <Show when={visibleStats().capped}>
            <span aria-hidden="true" class="h-2.5 w-px bg-border" />
            <span>
              {tf("voxel_graph.metric.omitted", {
                nodes: visibleStats().omittedNodes,
                links: visibleStats().omittedLinks,
              })}
            </span>
          </Show>
          <span aria-hidden="true" class="h-2.5 w-px bg-border" />
          <span>{tf("graph.tab.metric.clusters", { count: summary().clusterCount })}</span>
          <Show when={summary().orphanCount > 0}>
            <span aria-hidden="true" class="h-2.5 w-px bg-border" />
            <span>{tf("graph.tab.metric.orphan_other", { count: summary().orphanCount })}</span>
          </Show>
        </div>
      </div>

      <div class="relative flex min-h-0 flex-1">
        <VoxelCanvas
          variant="full"
          currentFilePath={currentFilePath()}
          onNodeClick={openGraphNode}
        />
      </div>
    </div>
  );
}
