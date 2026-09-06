// Development-only integration fixture; the production canvas and engine are unchanged imports.
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { createSignal, Show } from "solid-js";
import { createStore } from "solid-js/store";
import { render } from "solid-js/web";

import type { GraphState, GraphNode } from "~/plugins/builtin/graph_view/graph_types";
import VoxelCanvas from "~/plugins/builtin/voxel_graph/voxel_canvas";
import { setVoxelGraphStore } from "~/plugins/builtin/voxel_graph/voxel_store";
import { setAppearanceSetting } from "~/stores/settings";
import { initTheme, setTheme } from "~/stores/theme";
import "~/index.css";
mockWindows("main");
mockIPC(() => null);
setAppearanceSetting("language", "en");
const params = new URLSearchParams(location.search),
  folders = ["Projects", "Library", "Journal"];
setTheme(params.get("theme") === "dark" ? "dark" : "light");
const total = Math.max(0, Math.min(1200, Number(params.get("nodes") ?? 12)));
const nodes: GraphNode[] = Array.from({ length: total }, (_, i) => ({
  id: `note-${i}`,
  filePath: `${folders[i % 3]}/Note ${i}.md`,
  name: i === 0 ? "Garden Notes" : `Note ${i}`,
  folder: folders[i % 3],
  clusterIndex: i % 3,
  linkCount: i === 1 ? 8 : 2,
  isOrphan: false,
  documentLength: i === 1 ? 7500 : (i % 4) * 1200,
}));
const links = nodes.slice(1).map((n, i) => ({ source: nodes[i].filePath, target: n.filePath }));
const adjacencyMap: Record<string, string[]> = {};
nodes.forEach((n) => (adjacencyMap[n.filePath] = []));
links.forEach((l) => {
  adjacencyMap[l.source].push(l.target);
  adjacencyMap[l.target].push(l.source);
});
const [state, setState] = createStore<GraphState>({
  nodes,
  links,
  adjacencyMap,
  clusters: folders,
  isIndexing: false,
  lastIndexedAt: 1,
  error: null,
});
setVoxelGraphStore({
  state,
  buildGraphData: async () => {},
  scheduleRebuild: () => {},
  clear: () => setState({ nodes: [], links: [], clusters: [], adjacencyMap: {} }),
  dispose: () => {},
});
function Fixture() {
  initTheme();
  const [opened, setOpened] = createSignal<string | null>(null);
  return (
    <div
      style={{ height: "100vh", width: params.has("compact") ? "360px" : "100vw", display: "flex" }}
    >
      <VoxelCanvas
        variant={params.has("compact") ? "compact" : "full"}
        currentFilePath={opened()}
        onNodeClick={(n) => setOpened(n.filePath)}
      />
      <Show when={params.has("tools")}>
        <div
          style={{
            position: "fixed",
            right: "12px",
            bottom: "12px",
            display: "flex",
            gap: "8px",
            "z-index": 50,
          }}
        >
          <button
            class="rounded-xs border border-border bg-bg-elevated px-3 py-2 text-text-primary"
            onClick={() => setTheme("light")}
          >
            Light theme
          </button>
          <button
            class="rounded-xs border border-border bg-bg-elevated px-3 py-2 text-text-primary"
            onClick={() => setTheme("dark")}
          >
            Dark theme
          </button>
        </div>
      </Show>
      <output
        style={{
          position: "fixed",
          bottom: "12px",
          left: "20px",
          color: "white",
          "pointer-events": "none",
        }}
      >
        {opened()}
      </output>
    </div>
  );
}
render(() => <Fixture />, document.getElementById("fixture")!);
