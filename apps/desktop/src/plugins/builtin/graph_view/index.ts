// ── Graph View Plugin ──
//
// Entry point for the graph-view plugin. Registers two views
// (center tab + right panel) and manages store lifecycle.
//
// SolidJS design:
//   - `setGraphStore()` writes a SolidJS signal, so any component
//     reading `getGraphStore()` inside a tracking scope will
//     re-render when the store is created or destroyed.
//   - `lazy()` ensures graph_tab / graph_panel and their heavy
//     dependency (force-graph) are code-split into a separate chunk.
//   - View components internally call `getGraphStore()` — no props
//     threading needed.

import { lazy } from "solid-js";

import type { KukuPlugin } from "~/plugins/types";

import { createGraphParser } from "./graph_parser";
import { createGraphStore, setGraphStore } from "./graph_store";

// ── Lazy-loaded view components ──
//
// Each component reads the graph store via the module-level signal
// internally. No props are needed from the plugin host.

const GraphTabView = lazy(() => import("./graph_tab"));
const GraphPanelView = lazy(() => import("./graph_panel"));

// ── Plugin Definition ──

const graphViewPlugin: KukuPlugin = {
  id: "graph-view",
  name: "Graph View",
  version: "0.2.0",
  description: "Visualize wikilink connections across the vault",
  dependencies: ["wikilink"],

  views: [
    {
      id: "graph-view.tab",
      label: "Graph",
      location: { slot: "centerTab" },
      tabType: "graph",
      component: GraphTabView,
    },
    {
      id: "graph-view.panel",
      label: "Graph",
      location: { slot: "rightPanel" },
      component: GraphPanelView,
    },
  ],

  async activate(ctx) {
    const parser = createGraphParser();
    const store = createGraphStore({
      readFile: (path) => ctx.vault.readFile(path),
      listFiles: () => ctx.vault.listFiles(""),
      parser,
    });

    // Publish to the module-level signal so all consumers
    // (GraphTab, GraphPanel, GraphCanvas) react immediately.
    setGraphStore(store);

    // Auto-cleanup: clear the signal and dispose the store on deactivate.
    ctx.track(() => {
      setGraphStore(null);
      store.dispose();
    });

    // Expose store as a named service for other plugins (e.g. search).
    ctx.services.register("store", store);

    // ── Vault lifecycle ─────────────────────────────────────
    //
    // 1. If a vault is already open when the plugin activates,
    //    build the graph immediately.
    // 2. Listen for vault:opened → full rebuild.
    // 3. Listen for vault:closed → clear graph data.
    // 4. Listen for file changes → debounced incremental rebuild.

    if (ctx.vault.rootPath) {
      void store.buildGraphData();
    }

    ctx.events.on("vault:opened", () => {
      void store.buildGraphData();
    });

    ctx.events.on("vault:closed", () => {
      store.clear();
    });

    await ctx.vault.onFileChanged(() => {
      store.scheduleRebuild();
    });
  },
};

export { graphViewPlugin };
