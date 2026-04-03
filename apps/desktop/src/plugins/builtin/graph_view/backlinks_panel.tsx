// ── Backlinks Panel ──
//
// Displays wikilink backlinks at the bottom of the editor.
// Reads graph data via `getGraphStore()` and respects the
// `showBacklinks` toggle in graph settings.
//
// Rendered inside the editor scroll area so backlinks scroll
// naturally below the document content.

import { createMemo, For, Show } from "solid-js";

import { openTab } from "~/stores/files";

import { getGraphSettings } from "./graph_settings";
import { getBacklinks, getGraphStore } from "./graph_store";

// ── Helpers ───────────────────────────────────────────────────

function fileNameFromPath(path: string): string {
  const base = path.split("/").at(-1) ?? path;
  return base.replace(/\.(md|markdown|txt)$/i, "");
}

function openBacklink(filePath: string): void {
  openTab(fileNameFromPath(filePath), filePath, "editor");
}

// ── Component ─────────────────────────────────────────────────

interface BacklinksPanelProps {
  filePath: string | null;
}

export default function BacklinksPanel(props: BacklinksPanelProps) {
  const backlinks = createMemo(() => {
    const store = getGraphStore();
    const fp = props.filePath;
    if (!store || !fp) return [];

    const paths = getBacklinks(store, fp);
    // Resolve display names from graph nodes
    const nodeMap = new Map(store.state.nodes.map((n) => [n.filePath, n.name]));
    return paths.map((p) => ({
      filePath: p,
      title: nodeMap.get(p) ?? fileNameFromPath(p),
    }));
  });

  const visible = () => getGraphSettings().showBacklinks && backlinks().length > 0;

  return (
    <Show when={visible()}>
      <div
        class="relative z-10 mx-auto mt-[-8vh] flex shrink-0 flex-wrap items-center gap-2 px-10 pt-4 pb-6 md:px-12"
        style={{ "max-width": "var(--editor-max-width, 100%)" }}
      >
        <span class="flex items-center gap-1 text-[0.625rem] text-text-muted">
          <svg
            class="size-3 opacity-50"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M9 17H7A5 5 0 0 1 7 7h2" />
            <path d="M15 7h2a5 5 0 1 1 0 10h-2" />
            <line x1="8" y1="12" x2="16" y2="12" />
          </svg>
          <span>{backlinks().length}</span>
        </span>
        <div class="flex flex-wrap gap-1.5">
          <For each={backlinks()}>
            {(link) => (
              <button
                type="button"
                class="inline-flex cursor-pointer items-center gap-1 rounded-sm border-none bg-transparent px-2 py-0.75 text-[0.6875rem] text-text-muted transition-all duration-100 hover:bg-bg-secondary hover:text-text-primary"
                onClick={() => openBacklink(link.filePath)}
              >
                {link.title}
              </button>
            )}
          </For>
        </div>
      </div>
    </Show>
  );
}
