import { lazy } from "solid-js";

import type { KukuPlugin } from "~/plugins/types";

import { createSearchService, type SearchService } from "./service";
import { loadIndexerConfig, resetIndexerConfig } from "./settings";
import { resetIndexerStatus, startStatusPolling } from "./status_store";
import { setSearchService } from "../search/runtime";

const IndexerSettingsView = lazy(() =>
  import("./indexer_settings").then((m) => ({ default: m.IndexerSettings })),
);

let searchServiceRef: SearchService | null = null;

const coreIndexerPlugin: KukuPlugin = {
  id: "core-indexer",
  name: "Indexer",
  version: "0.1.0",
  description: "Search indexing service and status tracking",

  views: [
    {
      id: "core-indexer.settings",
      label: "Indexer",
      location: { slot: "settingsSection" },
      order: 30,
      component: IndexerSettingsView,
    },
  ],

  commands: [
    {
      id: "core-indexer.rebuildIndex",
      label: "Rebuild Search Index",
      category: "Indexer",
      execute: () => {
        if (!searchServiceRef) return;
        void searchServiceRef.requestRebuild();
      },
    },
  ],

  async reset() {
    await resetIndexerConfig(searchServiceRef ?? undefined);
    resetIndexerStatus();
  },

  activate(ctx) {
    const service = createSearchService();
    searchServiceRef = service;
    ctx.services.register("search", service);
    setSearchService(service);
    void loadIndexerConfig(service);

    const stopPolling = startStatusPolling(service);
    ctx.track(stopPolling);

    ctx.events.on("vault:closed", () => {
      resetIndexerStatus();
    });

    ctx.track(() => {
      setSearchService(null);
      searchServiceRef = null;
    });
  },
};

export { coreIndexerPlugin };
