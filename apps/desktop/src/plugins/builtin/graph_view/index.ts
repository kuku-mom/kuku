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
//     renderer dependencies are code-split into separate chunks.
//   - View components internally call `getGraphStore()` — no props
//     threading needed.

import { lazy } from "solid-js";

import type { AiProxyToolRegistry } from "~/plugins/builtin/core_tool_registry/types";
import type { SearchService } from "~/plugins/builtin/core_indexer/service";
import { registerFill } from "~/plugins/slots";
import type { KukuPlugin } from "~/plugins/types";
import { closeTab, filesState, openTab } from "~/stores/files";
import { closeRightPanelView, layoutState, openRightPanelView } from "~/stores/layout";

import {
  buildFindOrphanNotesPayload,
  buildSuggestLinksPayload,
  buildSuggestLinksQuery,
  buildVaultStatsPayload,
} from "./graph_proxy_tools";
import {
  GraphSettingsPanel,
  loadGraphSettings,
  restoreGraphSettingsDefaults,
} from "./graph_settings";
import { createGraphStore, getGraphStore, setGraphStore } from "./graph_store";

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
  canDisable: true,
  dependencies: ["wikilink", "core-indexer", "core-tool-registry"],

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

  commands: [
    {
      id: "graph.cycle",
      label: "Toggle Graph",
      category: "Graph",
      defaultKeys: ["$mod+KeyG"],
      global: true,
      execute: () => {
        const graphTab = filesState.tabs.find((t) => t.type === "graph");
        const rightHasGraph =
          layoutState.rightPanelOpen && layoutState.activeRightPanelViewId === "graph-view.panel";

        if (graphTab) {
          // Graph tab open in center → close it
          closeTab(graphTab.id);
        } else if (rightHasGraph) {
          // Right panel showing graph → move to center tab, close panel
          openTab("Graph", null, "graph");
          closeRightPanelView();
        } else {
          // Open the graph in the right panel
          openRightPanelView("graph-view.panel");
        }
      },
    },
  ],

  reset() {
    restoreGraphSettingsDefaults();
    getGraphStore()?.clear();
  },

  async activate(ctx) {
    // ── Load persisted graph settings ───────────────────────
    await loadGraphSettings();

    // ── Register settings section fill ──────────────────────
    const disposeFill = registerFill({
      id: "graph-view.settings",
      pluginId: "graph-view",
      slot: "settingsSection",
      label: "Graph View",
      order: 30,
      isActive: () => true,
      component: GraphSettingsPanel,
    });
    ctx.track(disposeFill);

    const search = ctx.services.get("core-indexer.search") as SearchService | undefined;
    if (!search) {
      throw new Error("core-indexer.search service not found");
    }
    const store = createGraphStore({ service: search });

    setGraphStore(store);
    ctx.track(() => {
      setGraphStore(null);
      store.dispose();
    });
    ctx.services.register("store", store);

    const proxyTools = ctx.services.get("core-tool-registry.proxyTools") as
      | AiProxyToolRegistry
      | undefined;
    if (proxyTools) {
      const registrations = [
        proxyTools.register({
          name: "find_related_notes",
          toolId: `${ctx.pluginId}.find_related_notes`,
          description: "Find notes directly linked to a given note path using the graph index",
          category: "graph",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "Vault-relative note path" },
            },
            required: ["path"],
          },
          handler: async (args) => {
            const path = typeof args.path === "string" ? args.path : "";
            if (!path) {
              throw new Error("path is required");
            }

            const neighbors = store.state.adjacencyMap[path] ?? [];
            const nodeById = new Map(store.state.nodes.map((node) => [node.id, node]));
            return JSON.stringify(
              {
                path,
                related: neighbors.map((neighbor) => ({
                  path: neighbor,
                  name: nodeById.get(neighbor)?.name ?? neighbor,
                })),
              },
              null,
              2,
            );
          },
        }),
        proxyTools.register({
          name: "find_orphan_notes",
          toolId: `${ctx.pluginId}.find_orphan_notes`,
          description: "Find notes with no or very few connections. Useful for graph cleanup.",
          category: "graph",
          parameters: {
            type: "object",
            properties: {
              limit: {
                type: "number",
                description: "Maximum number of unlinked notes to return. Default: 20.",
              },
            },
          },
          handler: async (args) =>
            JSON.stringify(buildFindOrphanNotesPayload(store.state, args.limit), null, 2),
        }),
        proxyTools.register({
          name: "get_vault_stats",
          toolId: `${ctx.pluginId}.get_vault_stats`,
          description: "Get vault health statistics: note count, link count, unlinked note count.",
          category: "graph",
          parameters: {
            type: "object",
            properties: {},
          },
          handler: async () =>
            JSON.stringify(buildVaultStatsPayload(store.state, await search.getStatus()), null, 2),
        }),
        proxyTools.register({
          name: "suggest_links",
          toolId: `${ctx.pluginId}.suggest_links`,
          description:
            "Suggest wiki-link targets for a document based on content similarity and graph proximity.",
          category: "graph",
          parameters: {
            type: "object",
            properties: {
              path: {
                type: "string",
                description: "Vault-relative file path to analyze for link suggestions.",
              },
              max_results: {
                type: "number",
                description: "Maximum suggestions to return. Default: 10.",
              },
            },
            required: ["path"],
          },
          handler: async (args) => {
            const path = typeof args.path === "string" ? args.path : "";
            if (!path) {
              throw new Error("path is required");
            }

            const result = await search.querySimple(buildSuggestLinksQuery(store.state, path), {
              maxResults: 20,
            });
            return JSON.stringify(
              buildSuggestLinksPayload(
                store.state,
                path,
                result,
                typeof args.max_results === "number" ? args.max_results : undefined,
              ),
              null,
              2,
            );
          },
        }),
      ];

      for (const dispose of registrations) {
        ctx.track(dispose);
      }
    }

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

    ctx.events.on("indexer:updated", () => {
      void store.buildGraphData();
    });

    await ctx.vault.onFileChanged(() => {
      store.scheduleRebuild();
    });
  },
};

export { graphViewPlugin };
