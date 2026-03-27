// ── Graph Panel (Right Sidebar) ──
//
// Compact graph view for the right panel slot.
//
// SolidJS reactivity:
//   - `getGraphStore()` is a signal accessor — reads are tracked
//   - Store properties accessed inside JSX / createMemo are granular
//   - No intermediate wrappers or manual subscriptions needed

import { type JSX, createEffect, createMemo, createSignal, Show } from "solid-js";

import { FitViewIcon, LocateIcon } from "~/components/icons";
import { getActiveTab, openTab } from "~/stores/files";

import { getGraphStore } from "./graph_store";
import { getGraphSummary, type GraphCanvasHandle, type GraphNode } from "./graph_types";
import GraphCanvas from "./graph_canvas";

// ── Helpers ───────────────────────────────────────────────────

function fileNameFromPath(path: string): string {
  return path.split("/").at(-1) ?? path;
}

function openGraphNode(node: GraphNode): void {
  openTab(fileNameFromPath(node.filePath), node.filePath, "editor");
}

// ── Component ─────────────────────────────────────────────────

export default function GraphPanel() {
  const [handle, setHandle] = createSignal<GraphCanvasHandle | null>(null);
  const [followMode, setFollowMode] = createSignal(false);

  // Derived state — reads signal inside tracking scope
  const store = createMemo(() => getGraphStore());
  const summary = createMemo(() => getGraphSummary(store()?.state ?? null));
  const currentFilePath = createMemo(() => getActiveTab()?.filePath ?? null);

  const isReady = createMemo(() => {
    const s = store()?.state;
    return s && !s.isIndexing && s.nodes.length > 0;
  });

  // ── Follow-mode effect ──
  // When follow is ON, auto-locate the node whenever the active tab changes.
  createEffect(() => {
    if (!followMode()) return;
    const path = currentFilePath();
    const h = handle();
    if (path && h) {
      h.locateNode(path);
    }
  });

  function toggleFollowMode(): void {
    const next = !followMode();
    setFollowMode(next);

    // Immediately locate when turning ON
    if (next) {
      const path = currentFilePath();
      const h = handle();
      if (path && h) {
        h.locateNode(path);
      }
    }
  }

  return (
    <div class="flex h-full min-h-0 flex-col overflow-hidden bg-bg-secondary">
      {/* ── Header ── */}
      <div class="border-b border-border/70 px-3 py-2">
        <div class="flex items-center justify-between">
          <div class="space-y-0.5">
            <p class="text-[0.8125rem] font-medium text-text-primary">Graph</p>
            <p class="text-[0.6875rem] text-text-muted">Note network</p>
          </div>
          <div class="flex items-center gap-2 text-[0.6875rem] text-text-muted">
            <span>{summary().nodeCount}</span>
            <span class="text-border">/</span>
            <span>{summary().linkCount}</span>
          </div>
        </div>

        <Show when={store()?.state.error}>
          <p class="mt-2 text-[0.6875rem] text-text-muted">{store()?.state.error}</p>
        </Show>
      </div>

      {/* ── Canvas ── */}
      <div class="flex min-h-0 flex-1 p-2">
        <GraphCanvas
          variant="compact"
          currentFilePath={currentFilePath()}
          onNodeClick={openGraphNode}
          onHandle={setHandle}
        />
      </div>

      {/* ── Quick Actions (only when graph is rendered) ── */}
      <Show when={isReady() && handle()}>
        <div class="flex items-center justify-between border-t border-border/70 px-3 py-1.5">
          <div class="flex items-center gap-1">
            <PanelBtn title="Fit view" onClick={() => handle()?.fitView()}>
              <FitViewIcon />
            </PanelBtn>

            <PanelBtn
              title={followMode() ? "Stop following current note" : "Follow current note"}
              onClick={toggleFollowMode}
              active={followMode()}
            >
              <LocateIcon />
            </PanelBtn>
          </div>
          <span class="text-[0.625rem] text-text-muted">
            {summary().clusterCount} cluster{summary().clusterCount !== 1 ? "s" : ""}
          </span>
        </div>
      </Show>
    </div>
  );
}

// ── Panel Button (private) ────────────────────────────────────

function PanelBtn(props: {
  title: string;
  onClick: () => void;
  active?: boolean;
  children: JSX.Element;
}): JSX.Element {
  return (
    <button
      type="button"
      title={props.title}
      class="flex size-5 cursor-pointer items-center justify-center rounded-md border-none bg-transparent text-[0.6875rem] text-text-muted transition-colors hover:bg-ghost-hover hover:text-text-primary"
      classList={{ "bg-ghost-hover! text-text-primary!": props.active }}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}
