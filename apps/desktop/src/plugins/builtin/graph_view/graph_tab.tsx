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

import { type JSX, createMemo, createSignal, For, lazy, Show, Suspense } from "solid-js";

import { ClustersIcon } from "~/components/icons";
import { t } from "~/i18n";
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
  const [legendOpen, setLegendOpen] = createSignal(false);

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

  const clusters = createMemo(() => store()?.state.clusters ?? []);

  return (
    <div class="relative flex h-full min-h-0 flex-col overflow-hidden bg-bg-primary">
      {/* ── Canvas ── */}
      <div class="relative flex min-h-0 flex-1">
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
        <div
          data-kuku-graph-view-controls="true"
          class="absolute top-3 right-3 z-30 flex w-10 flex-col items-center gap-1 rounded-xs border border-border/70 bg-bg-elevated/85 p-1 shadow-soft-2 backdrop-blur-sm"
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
          <Show when={summary().clusterCount > 0}>
            <button
              type="button"
              title={t("graph.legend")}
              aria-label={t("graph.legend")}
              aria-expanded={legendOpen()}
              class="flex size-8 cursor-pointer items-center justify-center rounded-xs border-none bg-transparent text-text-muted transition-colors hover:bg-ghost-hover hover:text-text-primary"
              classList={{
                "bg-element-selected text-text-primary shadow-soft-1": legendOpen(),
              }}
              onClick={() => {
                setLegendOpen((open) => !open);
              }}
            >
              <ClustersIcon size={14} />
            </button>
          </Show>
        </div>
        <Show when={legendOpen() && summary().clusterCount > 0}>
          <div
            data-kuku-graph-legend-popover="true"
            class="absolute top-3 right-16 z-20 flex max-h-[min(70vh,28rem)] w-64 flex-col overflow-hidden rounded-xs border border-border/70 bg-bg-elevated/95 shadow-popover backdrop-blur-sm"
          >
            <div class="flex min-h-0 flex-col gap-1 overflow-y-auto p-2">
              <For each={clusters()}>
                {(cluster, i) => (
                  <div class="flex min-h-7 items-center gap-2 rounded-xs px-2 text-[0.75rem] text-text-secondary hover:bg-ghost-hover/60">
                    <span
                      class="inline-block size-2.5 shrink-0 rounded-full ring-1 ring-border"
                      style={{ background: clusterColor(i()) }}
                    />
                    <span class="min-w-0 truncate">{cluster.split("/").pop() ?? cluster}</span>
                  </div>
                )}
              </For>
            </div>
          </div>
        </Show>
      </div>
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
      class="size-8 text-[0.625rem] cursor-pointer rounded-xs border-none px-1 font-medium leading-none transition-colors duration-100 hover:bg-ghost-hover hover:text-text-primary"
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
