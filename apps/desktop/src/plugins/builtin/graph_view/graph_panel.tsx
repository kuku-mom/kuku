// ── Graph Panel (Right Sidebar) ──
//
// Compact graph view for the right panel slot.
//
// SolidJS reactivity:
//   - `getGraphStore()` is a signal accessor — reads are tracked
//   - Store properties accessed inside JSX / createMemo are granular
//   - No intermediate wrappers or manual subscriptions needed

import { createMemo, lazy, Show, Suspense, type JSX } from "solid-js";

import { t } from "~/i18n";
import { getActiveTab, openTab } from "~/stores/files";
import { closeRightPanelView } from "~/stores/layout";

import { type GraphNode } from "./graph_types";
import GraphCanvas from "./graph_canvas_pixi";
import { graphViewMode, setGraphViewMode } from "./graph_view_mode";

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

const GraphCanvas3D = lazy(() => import("./graph_canvas_3d"));

// ── Component ─────────────────────────────────────────────────

export default function GraphPanel() {
  // Derived state — reads signal inside tracking scope
  const currentFilePath = createMemo(() => getActiveTab()?.filePath ?? null);

  return (
    <div class="flex h-full min-h-0 flex-col overflow-hidden bg-bg-secondary/60">
      <div class="flex shrink-0 items-center justify-between gap-2 border-b border-border/70 bg-bg-primary/50 px-2 py-1.5">
        <p class="min-w-0 truncate text-[0.75rem] font-medium text-text-primary">
          {t("graph.title")}
        </p>
        <div class="flex shrink-0 items-center gap-1">
          <div
            class="flex items-center rounded-xs border border-border/70 bg-bg-secondary/70 p-0.5 text-[0.625rem] text-text-muted"
            role="group"
            aria-label={t("graph.tab.view_mode")}
          >
            <PanelModeBtn
              active={graphViewMode() === "2d"}
              title={t("graph.tab.view_2d")}
              onClick={() => setGraphViewMode("2d")}
            >
              2D
            </PanelModeBtn>
            <PanelModeBtn
              active={graphViewMode() === "3d"}
              title={t("graph.tab.view_3d")}
              onClick={() => setGraphViewMode("3d")}
            >
              3D
            </PanelModeBtn>
          </div>
          <button
            type="button"
            class="cursor-pointer rounded-xs border-none bg-transparent px-1 py-0.5 text-[0.6875rem] text-text-muted transition-colors hover:bg-ghost-hover hover:text-text-primary"
            title={t("graph.action.open_center_title")}
            onClick={openGraphInCenterTab}
          >
            {t("graph.action.open_in_tab")}
          </button>
        </div>
      </div>
      {/* ── Canvas ── */}
      <div class="flex min-h-0 flex-1">
        <Show
          when={graphViewMode() === "3d"}
          fallback={
            <GraphCanvas
              variant="compact"
              currentFilePath={currentFilePath()}
              onNodeClick={openGraphNode}
              initialFollowMode
            />
          }
        >
          <Suspense
            fallback={
              <GraphCanvas
                variant="compact"
                currentFilePath={currentFilePath()}
                initialFollowMode
              />
            }
          >
            <GraphCanvas3D
              variant="compact"
              currentFilePath={currentFilePath()}
              onNodeClick={openGraphNode}
              initialFollowMode
            />
          </Suspense>
        </Show>
      </div>
    </div>
  );
}

function PanelModeBtn(props: {
  active: boolean;
  title: string;
  onClick: () => void;
  children: JSX.Element;
}): JSX.Element {
  return (
    <button
      type="button"
      title={props.title}
      class="h-5 min-w-7 cursor-pointer rounded-xs border-none px-1.5 font-medium transition-colors duration-100 hover:bg-ghost-hover hover:text-text-primary"
      classList={{
        "bg-element-selected text-text-primary": props.active,
        "bg-transparent text-text-muted": !props.active,
      }}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}
