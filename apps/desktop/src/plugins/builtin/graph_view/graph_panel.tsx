// ── Graph Panel (Right Sidebar) ──
//
// Compact graph view for the right panel slot.
//
// SolidJS reactivity:
//   - `getGraphStore()` is a signal accessor — reads are tracked
//   - Store properties accessed inside JSX / createMemo are granular
//   - No intermediate wrappers or manual subscriptions needed

import { createMemo, lazy, Show, Suspense, type JSX } from "solid-js";

import { OpenInTabIcon } from "~/components/icons";
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
    <div class="relative flex h-full min-h-0 flex-col overflow-hidden bg-bg-primary">
      {/* ── Canvas ── */}
      <div class="relative flex min-h-0 flex-1">
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
        <div
          data-kuku-graph-panel-controls="true"
          class="absolute top-2 right-2 z-30 flex w-7 flex-col items-center gap-0 rounded-xs border border-border/70 bg-bg-elevated/85 p-0.5 shadow-soft-2 backdrop-blur-sm"
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
          <button
            type="button"
            class="flex size-6 cursor-pointer items-center justify-center rounded-xs border-none bg-transparent text-text-muted transition-colors hover:bg-ghost-hover hover:text-text-primary"
            title={t("graph.action.open_center_title")}
            aria-label={t("graph.action.open_in_tab")}
            onClick={openGraphInCenterTab}
          >
            <OpenInTabIcon size={12} />
          </button>
        </div>
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
      class="size-6 cursor-pointer rounded-xs border-none px-0 text-[0.5625rem] font-medium leading-none transition-colors duration-100 hover:bg-ghost-hover hover:text-text-primary"
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
