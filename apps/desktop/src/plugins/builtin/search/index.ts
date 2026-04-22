import { lazy } from "solid-js";

import { openTab } from "~/stores/files";
import type { KukuPlugin } from "~/plugins/types";

import { isSearchOmnibarOpen, openSearchOmnibar, resetSearchOmnibarState } from "./omnibar_state";
import { setSearchService } from "./runtime";
import { resetSearchModeState } from "./search_mode_state";
import type { SearchService } from "../core_indexer/service";

const SearchTabView = lazy(() => import("./search_tab"));
const SearchOmnibarView = lazy(() => import("./omnibar"));

const searchPlugin: KukuPlugin = {
  id: "search",
  name: "Search",
  version: "0.1.0",
  description: "Quick Search & Advanced Search",
  dependencies: ["core-indexer"],

  views: [
    {
      id: "search.tab",
      label: "Advanced Search",
      location: { slot: "centerTab" },
      tabType: "search",
      component: SearchTabView,
    },
    {
      id: "search.omnibar",
      label: "Quick Search",
      location: { slot: "overlay" },
      component: SearchOmnibarView,
      isActive: () => isSearchOmnibarOpen(),
    },
  ],

  commands: [
    {
      id: "search.openOmnibar",
      label: "Quick Search",
      category: "Search",
      defaultKeys: ["$mod+KeyP"],
      global: true,
      execute: () => openSearchOmnibar(),
    },
    {
      id: "search.openAdvanced",
      label: "Advanced Search",
      category: "Search",
      defaultKeys: ["$mod+KeyU"],
      global: true,
      execute: () => openTab("Advanced Search", null, "search"),
    },
  ],

  reset() {
    resetSearchModeState();
    resetSearchOmnibarState();
  },

  activate(ctx) {
    const service = ctx.services.get("core-indexer.search") as SearchService | undefined;
    if (!service) {
      throw new Error("core-indexer.search service not found");
    }

    setSearchService(service);
    ctx.track(() => setSearchService(null));
  },
};

export { searchPlugin };
