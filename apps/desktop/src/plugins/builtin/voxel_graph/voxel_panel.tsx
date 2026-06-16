// ── Agent World Panel ──
//
// Compact right-panel view for the roaming agent world.

import { createMemo } from "solid-js";

import { t } from "~/i18n";
import { type GraphNode } from "~/plugins/builtin/graph_view/graph_types";
import { getActiveTab, openTab } from "~/stores/files";
import { closeRightPanelView } from "~/stores/layout";

import VoxelCanvas from "./voxel_canvas";

function fileNameFromPath(path: string): string {
  return path.split("/").at(-1) ?? path;
}

function openGraphNode(node: GraphNode): void {
  openTab(fileNameFromPath(node.filePath), node.filePath, "editor");
}

function openVoxelInCenterTab(): void {
  openTab("Agent World", null, "voxel-graph", { focusFilePath: currentFilePathForGraph() });
  closeRightPanelView();
}

function currentFilePathForGraph(): string | null {
  const activeTab = getActiveTab();
  return activeTab?.type === "editor" ? (activeTab.filePath ?? null) : null;
}

export default function VoxelGraphPanel() {
  const currentFilePath = createMemo(currentFilePathForGraph);

  return (
    <div class="flex h-full min-h-0 flex-col overflow-hidden bg-bg-secondary/60">
      <div class="flex shrink-0 items-center justify-between gap-2 border-b border-border/70 bg-bg-primary/50 px-2 py-1.5">
        <p class="min-w-0 truncate text-[0.75rem] font-medium text-text-primary">
          {t("voxel_graph.title")}
        </p>
        <button
          type="button"
          class="cursor-pointer rounded-xs border-none bg-transparent px-1 py-0.5 text-[0.6875rem] text-text-muted transition-colors hover:bg-ghost-hover hover:text-text-primary"
          title={t("voxel_graph.action.open_center_title")}
          onClick={openVoxelInCenterTab}
        >
          {t("graph.action.open_in_tab")}
        </button>
      </div>
      <div class="flex min-h-0 flex-1">
        <VoxelCanvas
          variant="compact"
          currentFilePath={currentFilePath()}
          onNodeClick={openGraphNode}
        />
      </div>
    </div>
  );
}
