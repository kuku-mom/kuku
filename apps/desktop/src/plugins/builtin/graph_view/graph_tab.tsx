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

import {
  type JSX,
  createEffect,
  createMemo,
  createSignal,
  For,
  lazy,
  onCleanup,
  Show,
  Suspense,
} from "solid-js";

import { CheckIcon, ListIcon, SettingsIcon } from "~/components/icons";
import { t } from "~/i18n";
import { getEffectiveTheme } from "~/stores/theme";
import { GraphSettingsPanel } from "./graph_settings";
import { constellationColor } from "./graph_constellation";
import { getActiveTab, openTab } from "~/stores/files";

import GraphCanvas from "./graph_canvas_pixi";
import { getGraphStore } from "./graph_store";
import { graphViewMode, setGraphViewMode } from "./graph_view_mode";
import {
  clusterColor,
  getGraphSummary,
  type GraphCanvasHandle,
  type GraphNode,
  type GraphNodeFilter,
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
  let legendButtonEl: HTMLButtonElement | undefined;
  let legendPopoverEl: HTMLDivElement | undefined;

  // Handle is stored for future toolbar integration (e.g. external zoom buttons).
  // Currently only `setHandle` is used as the onHandle callback.
  const [, setHandle] = createSignal<GraphCanvasHandle | null>(null);
  const [legendOpen, setLegendOpen] = createSignal(false);
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const [selectedLegendClusterIndexes, setSelectedLegendClusterIndexes] = createSignal<Set<number>>(
    new Set(),
  );

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
  const legendNodeFilter = createMemo<GraphNodeFilter | undefined>(() => {
    const selected = selectedLegendClusterIndexes();
    if (selected.size === 0) return undefined;
    return (node) => selected.has(node.clusterIndex);
  });

  function isLegendClusterSelected(index: number): boolean {
    return selectedLegendClusterIndexes().has(index);
  }

  function toggleLegendCluster(index: number): void {
    setSelectedLegendClusterIndexes((current) => {
      const next = new Set(current);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  }

  createEffect(() => {
    const clusterCount = clusters().length;
    const selected = selectedLegendClusterIndexes();
    if ([...selected].some((index) => index >= clusterCount)) {
      setSelectedLegendClusterIndexes(
        new Set([...selected].filter((index) => index < clusterCount)),
      );
    }
  });

  createEffect(() => {
    if (!legendOpen()) return;

    const handleLegendOutsidePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (legendButtonEl?.contains(target) || legendPopoverEl?.contains(target)) return;
      setLegendOpen(false);
    };

    document.addEventListener("pointerdown", handleLegendOutsidePointerDown, true);
    onCleanup(() => {
      document.removeEventListener("pointerdown", handleLegendOutsidePointerDown, true);
    });
  });

  return (
    <div
      class="relative flex h-full min-h-0 flex-col overflow-hidden bg-bg-primary"
      data-kuku-constellation={graphViewMode() === "3d" ? "true" : undefined}
    >
      <Show when={graphViewMode() === "3d"}>
        <header class="kuku-constellation-header">
          <div class="kuku-constellation-title">
            <span>Kuku</span>
            <span aria-hidden="true">/</span>
            <span>{t("graph.title")}</span>
          </div>
          <div class="kuku-constellation-header-actions">
            <div class="kuku-constellation-modes">
              <ModeBtn
                active={false}
                title={t("graph.tab.view_2d")}
                onClick={() => setGraphViewMode("2d")}
              >
                2D
              </ModeBtn>
              <ModeBtn active title={t("graph.tab.view_3d")} onClick={() => setGraphViewMode("3d")}>
                3D
              </ModeBtn>
            </div>
            <button
              type="button"
              class="kuku-constellation-settings-button"
              title={t("settings.plugin.graph_view.title")}
              aria-label={t("settings.plugin.graph_view.title")}
              aria-expanded={settingsOpen()}
              onClick={() => setSettingsOpen((open) => !open)}
            >
              <SettingsIcon size={16} />
            </button>
          </div>
        </header>
      </Show>
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
              nodeFilter={legendNodeFilter()}
              preserveFilteredClusterColors
            />
          }
        >
          <Suspense
            fallback={
              <GraphCanvas
                variant="full"
                currentFilePath={currentFilePath()}
                nodeFilter={legendNodeFilter()}
                preserveFilteredClusterColors
              />
            }
          >
            <GraphCanvas3D
              variant="full"
              currentFilePath={currentFilePath()}
              onNodeClick={openGraphNode}
              onHandle={setHandle}
              nodeFilter={legendNodeFilter()}
              preserveFilteredClusterColors
            />
          </Suspense>
        </Show>
        <Show when={graphViewMode() === "2d"}>
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
                ref={legendButtonEl}
                type="button"
                title={t("graph.legend")}
                aria-label={t("graph.legend")}
                aria-expanded={legendOpen()}
                class="flex size-8 cursor-pointer items-center justify-center rounded-xs border-none bg-transparent text-text-muted transition-colors hover:bg-ghost-hover hover:text-text-primary"
                classList={{
                  "bg-element-selected text-text-primary": legendOpen(),
                }}
                onClick={() => {
                  setLegendOpen((open) => !open);
                }}
              >
                <ListIcon size={14} />
              </button>
            </Show>
          </div>
        </Show>
        <Show when={graphViewMode() === "2d" && legendOpen() && summary().clusterCount > 0}>
          <div
            ref={legendPopoverEl}
            data-kuku-graph-legend-popover="true"
            class="absolute top-3 right-16 z-20 flex max-h-[min(70vh,28rem)] w-64 flex-col overflow-hidden rounded-xs border border-border/70 bg-bg-elevated/95 shadow-popover backdrop-blur-sm"
          >
            <div
              data-kuku-graph-legend-list="true"
              data-kuku-scrollbar-hidden="true"
              class="flex min-h-0 flex-col gap-1 overflow-y-auto p-2"
            >
              <For each={clusters()}>
                {(cluster, i) => (
                  <button
                    type="button"
                    data-kuku-graph-legend-item="true"
                    data-kuku-graph-legend-filtered={
                      isLegendClusterSelected(i()) ? "true" : "false"
                    }
                    aria-pressed={isLegendClusterSelected(i())}
                    class="flex min-h-7 cursor-pointer items-center gap-2 rounded-xs border-none bg-transparent px-2 text-left text-[0.75rem] text-text-secondary transition-colors hover:bg-ghost-hover/60 hover:text-text-primary"
                    classList={{
                      "bg-element-selected text-text-primary": isLegendClusterSelected(i()),
                    }}
                    onClick={() => {
                      toggleLegendCluster(i());
                    }}
                  >
                    <span
                      class="inline-block size-2.5 shrink-0 rounded-full ring-1 ring-border"
                      style={{ background: clusterColor(i()) }}
                    />
                    <span class="min-w-0 flex-1 truncate">
                      {cluster.split("/").pop() ?? cluster}
                    </span>
                    <Show when={isLegendClusterSelected(i())}>
                      <span
                        data-kuku-graph-legend-active-indicator="true"
                        class="flex size-4 shrink-0 items-center justify-center text-text-primary"
                      >
                        <CheckIcon size={11} />
                      </span>
                    </Show>
                  </button>
                )}
              </For>
            </div>
          </div>
        </Show>
        <Show when={graphViewMode() === "3d" && summary().clusterCount > 0}>
          <nav class="kuku-constellation-legend" aria-label={t("graph.legend")}>
            <For each={clusters()}>
              {(cluster, i) => (
                <button
                  type="button"
                  aria-pressed={isLegendClusterSelected(i())}
                  title={cluster}
                  data-filtered={
                    selectedLegendClusterIndexes().size > 0 && !isLegendClusterSelected(i())
                  }
                  onClick={() => toggleLegendCluster(i())}
                >
                  <span
                    class="kuku-constellation-swatch"
                    style={{ background: constellationColor(i(), getEffectiveTheme()) }}
                  />
                  <span>{cluster.split("/").pop() || "/"}</span>
                </button>
              )}
            </For>
          </nav>
        </Show>
        <Show when={graphViewMode() === "3d" && settingsOpen()}>
          <div class="kuku-constellation-settings">
            <GraphSettingsPanel mode="3d" onClose={() => setSettingsOpen(false)} />
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
      aria-label={props.title}
      aria-pressed={props.active}
      class="size-8 cursor-pointer rounded-xs border-none px-1 text-[0.625rem] leading-none font-medium transition-colors duration-100 hover:bg-ghost-hover hover:text-text-primary"
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
