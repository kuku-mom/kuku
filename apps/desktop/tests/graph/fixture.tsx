// Local integration fixture: real graph components, synthetic documents only.
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { createEffect, createSignal, Show } from "solid-js";
import { createStore } from "solid-js/store";
import { render } from "solid-js/web";

import GraphCanvas3D from "~/plugins/builtin/graph_view/graph_canvas_3d";
import { setGraphStore } from "~/plugins/builtin/graph_view/graph_store";
import GraphTab from "~/plugins/builtin/graph_view/graph_tab";
import type { GraphState, GraphNode, GraphLink } from "~/plugins/builtin/graph_view/graph_types";
import { setGraphViewMode } from "~/plugins/builtin/graph_view/graph_view_mode";
import { filesState, openTab } from "~/stores/files";
import { setAppearanceSetting } from "~/stores/settings";
import { getEffectiveTheme, setTheme } from "~/stores/theme";
import "~/index.css";
mockWindows("main");
mockIPC(() => null);
const params = new URLSearchParams(location.search);
setTheme(params.get("theme") === "light" ? "light" : "dark");
setAppearanceSetting("language", "en");
setGraphViewMode("3d");
openTab("Graph", null, "graph");
const folders = ["Notes", "Projects", "Research", "Journal", "Ideas"];
const names = [
  "Design systems",
  "Spatial interfaces",
  "Reading notes",
  "Product strategy",
  "Daily ideas",
];
const nodes: GraphNode[] = [];
const links: GraphLink[] = [];
const adjacencyMap: Record<string, string[]> = {};
const total = Number(params.get("nodes") ?? 220);
for (let i = 0; i < total; i++) {
  const clusterIndex = i % 5;
  const folder = folders[clusterIndex];
  const filePath = `${folder}/${i < 5 ? names[i] : `Note ${i}`}.md`;
  nodes.push({
    id: filePath,
    filePath,
    name: i < 5 ? names[i] : `Note ${i}`,
    folder,
    clusterIndex,
    linkCount: 0,
    isOrphan: false,
  });
  adjacencyMap[filePath] = [];
}
function connect(a: number, b: number) {
  if (!nodes[a] || !nodes[b] || a === b) return;
  const source = nodes[a].filePath,
    target = nodes[b].filePath;
  if (adjacencyMap[source].includes(target)) return;
  links.push({ source, target });
  adjacencyMap[source].push(target);
  adjacencyMap[target].push(source);
}
for (let i = 5; i < total; i++) {
  if (i % 3 === 0) connect(i, i % 5);
  if (i > 10) connect(i, i - 5);
}
for (let i = 1; i < 5; i++) connect(0, i);
for (const node of nodes) {
  node.linkCount = adjacencyMap[node.filePath].length;
  node.isOrphan = node.linkCount === 0;
}
const [state, setState] = createStore<GraphState>({
  nodes,
  links,
  adjacencyMap,
  clusters: folders,
  isIndexing: false,
  lastIndexedAt: 1,
  error: null,
});
setGraphStore({
  state,
  buildGraphData: async () => {},
  scheduleRebuild: () => {},
  clear: () => setState({ nodes: [], links: [], clusters: [], adjacencyMap: {} }),
  dispose: () => {},
});
function Fixture() {
  const [visible, setVisible] = createSignal(true);
  createEffect(() => document.documentElement.setAttribute("data-theme", getEffectiveTheme()));
  return (
    <>
      <div style={{ height: "100vh", width: "100vw" }}>
        <Show when={visible()}>
          <Show when={params.has("compact")} fallback={<GraphTab />}>
            <div style={{ width: "340px", height: "440px", display: "flex" }}>
              <GraphCanvas3D variant="compact" />
            </div>
          </Show>
        </Show>
      </div>
      <aside
        style={{
          position: "fixed",
          bottom: "2px",
          right: "8px",
          "z-index": 90,
          display: "flex",
          gap: "8px",
          "font-size": "10px",
          color: "#9299ae",
        }}
      >
        <button onClick={() => setTheme(getEffectiveTheme() === "dark" ? "light" : "dark")}>
          Toggle theme
        </button>
        <button onClick={() => setState({ nodes: [], links: [], clusters: [], adjacencyMap: {} })}>
          Empty
        </button>
        <button
          onClick={() =>
            setState({
              nodes: [...nodes],
              links: [...links],
              clusters: folders,
              adjacencyMap,
              lastIndexedAt: Date.now(),
            })
          }
        >
          Reload data
        </button>
        <button onClick={() => setVisible((value) => !value)}>Mount/unmount</button>
        <output>{filesState.tabs.at(-1)?.filePath}</output>
      </aside>
    </>
  );
}
const host = document.getElementById("fixture");
if (host) render(() => <Fixture />, host);
