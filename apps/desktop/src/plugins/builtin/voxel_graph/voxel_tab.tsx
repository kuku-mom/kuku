// ── Agent World Tab ──
//
// Full center-tab view for the agent world renderer.

import { createMemo } from "solid-js";

import { type GraphNode } from "~/plugins/builtin/graph_view/graph_types";
import { getActiveTab, openTab } from "~/stores/files";

import VoxelCanvas from "./voxel_canvas";

function fileNameFromPath(path: string): string {
  return path.split("/").at(-1) ?? path;
}

function openGraphNode(node: GraphNode): void {
  openTab(fileNameFromPath(node.filePath), node.filePath, "editor");
}

export default function VoxelGraphTab() {
  const currentFilePath = createMemo(() => {
    const tab = getActiveTab();
    if (tab?.type === "voxel-graph") {
      return tab.state?.focusFilePath ?? null;
    }
    return tab?.type === "editor" && tab.filePath ? tab.filePath : null;
  });

  return (
    <div class="flex h-full min-h-0 flex-col overflow-hidden bg-bg-primary">
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
