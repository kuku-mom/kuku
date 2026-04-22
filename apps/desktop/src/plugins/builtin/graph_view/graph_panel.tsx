// ── Graph Panel (Right Sidebar) ──
//
// Compact graph view for the right panel slot.
//
// SolidJS reactivity:
//   - `getGraphStore()` is a signal accessor — reads are tracked
//   - Store properties accessed inside JSX / createMemo are granular
//   - No intermediate wrappers or manual subscriptions needed

import { createMemo } from "solid-js";

import { getActiveTab, openTab } from "~/stores/files";
import { closeRightPanelView } from "~/stores/layout";

import { type GraphNode } from "./graph_types";
import GraphCanvas from "./graph_canvas";

// ── Helpers ───────────────────────────────────────────────────

function fileNameFromPath(path: string): string {
  return path.split("/").at(-1) ?? path;
}

function openGraphNode(node: GraphNode): void {
  openTab(fileNameFromPath(node.filePath), node.filePath, "editor");
}

/** Same as the graph.cycle command when the graph is only in the right panel: center tab + close panel. */
function openGraphInCenterTab(): void {
  openTab("Graph", null, "graph");
  closeRightPanelView();
}

// ── Component ─────────────────────────────────────────────────

export default function GraphPanel() {
  // Derived state — reads signal inside tracking scope
  const currentFilePath = createMemo(() => getActiveTab()?.filePath ?? null);

  return (
    <div class="flex h-full min-h-0 flex-col overflow-hidden bg-bg-secondary/60">
      <div class="flex shrink-0 items-center justify-between gap-2 border-b border-border/70 bg-bg-primary/50 px-2 py-1.5">
        <p class="min-w-0 truncate text-[0.75rem] font-medium text-text-primary">Graph</p>
        <button
          type="button"
          class="shrink-0 cursor-pointer rounded-xs border-none bg-transparent px-1 py-0.5 text-[0.6875rem] text-text-muted transition-colors hover:bg-ghost-hover hover:text-text-primary"
          title="Open in center (⌘G)"
          onClick={openGraphInCenterTab}
        >
          Open in tab
        </button>
      </div>
      {/* ── Canvas ── */}
      <div class="flex min-h-0 flex-1">
        <GraphCanvas
          variant="compact"
          currentFilePath={currentFilePath()}
          onNodeClick={openGraphNode}
        />
      </div>
    </div>
  );
}
