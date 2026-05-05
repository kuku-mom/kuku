// ── Graph Panel (Right Sidebar) ──
//
// Compact graph view for the right panel slot.
//
// SolidJS reactivity:
//   - `getGraphStore()` is a signal accessor — reads are tracked
//   - Store properties accessed inside JSX / createMemo are granular
//   - No intermediate wrappers or manual subscriptions needed

import { createMemo } from "solid-js";

import { t } from "~/i18n";
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
      <div class="flex h-10 shrink-0 items-center justify-between border-b border-border bg-bg-primary px-3">
        <div class="flex min-w-0 items-center gap-2">
          <span class="size-1.5 shrink-0 rounded-full bg-text-muted/30" aria-hidden="true" />
          <span class="truncate text-[0.6875rem] font-medium tracking-wide text-text-muted">
            {t("graph.title")}
          </span>
        </div>
        <button
          type="button"
          class="shrink-0 cursor-pointer rounded-md border-none bg-transparent px-2 py-1 text-[0.6875rem] text-text-muted transition-colors hover:bg-ghost-hover hover:text-text-primary"
          title={t("graph.action.open_center_title")}
          onClick={openGraphInCenterTab}
        >
          {t("graph.action.open_in_tab")}
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
