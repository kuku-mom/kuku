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

import type { AiProxyToolRegistry } from "~/plugins/builtin/ai_chat/types";
import type { SearchService } from "~/plugins/builtin/core_indexer/service";
import type { KukuPlugin } from "~/plugins/types";

import { createGraphParser } from "./graph_parser";
import {
  buildFindOrphanNotesPayload,
  buildSuggestLinksPayload,
  buildSuggestLinksQuery,
  buildVaultStatsPayload,
} from "./graph_proxy_tools";
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
  canDisable: true,
  dependencies: ["wikilink", "ai-chat", "core-indexer"],

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
    const search = ctx.services.get<SearchService>("core-indexer.search");
    if (!search) {
      throw new Error("core-indexer.search service not found");
    }

    const proxyTools = ctx.services.get<AiProxyToolRegistry>("ai-chat.proxyTools");
    if (proxyTools) {
      const registrations = [
        proxyTools.register({
          name: "find_related_notes",
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
          description: "Find notes with no or very few connections. Useful for graph cleanup.",
          category: "graph",
          parameters: {
            type: "object",
            properties: {
              limit: {
                type: "number",
                description: "Maximum number of orphan notes to return. Default: 20.",
              },
            },
          },
          handler: async (args) =>
            JSON.stringify(buildFindOrphanNotesPayload(store.state, args.limit), null, 2),
        }),
        proxyTools.register({
          name: "get_vault_stats",
          description: "Get vault health statistics: note count, link count, orphan count.",
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

    await ctx.vault.onFileChanged(() => {
      store.scheduleRebuild();
    });
  },
};

export { graphViewPlugin };
