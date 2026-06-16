// ── Agent World Plugin ──
//
// A graph-view alternative that renders the vault as a living voxel
// archipelago: every folder is an island, every note is a house with a
// resident agent, and wikilinks become bridges and glowing data pulses.
// It owns its own graph store so it can be enabled/disabled independently
// from the standard Graph View plugin.

import { lazy } from "solid-js";

import type { SearchService } from "~/plugins/builtin/core_indexer/service";
import type { KukuPlugin } from "~/plugins/types";
import { closeTab, filesState, getActiveTab, openTab } from "~/stores/files";
import { closeRightPanelView, layoutState, openRightPanelView } from "~/stores/layout";

import { loadVoxelRenderSettings, restoreVoxelRenderSettingsDefaults } from "./voxel_settings";
import { createVoxelGraphStore, getVoxelGraphStore, setVoxelGraphStore } from "./voxel_store";

const VoxelGraphTabView = lazy(() => import("./voxel_tab"));
const VoxelGraphPanelView = lazy(() => import("./voxel_panel"));
const VoxelGraphSettingsView = lazy(() =>
  import("./voxel_settings_view").then((module) => ({
    default: module.VoxelSettingsView,
  })),
);

const VOXEL_TAB_TYPE = "voxel-graph";
const VOXEL_PANEL_ID = "voxel-graph.panel";

function openVoxelTab(): void {
  const activeTab = getActiveTab();
  const focusFilePath = activeTab?.type === "editor" ? (activeTab.filePath ?? null) : null;
  openTab("Agent World", null, VOXEL_TAB_TYPE, { focusFilePath });
}

const voxelGraphPlugin: KukuPlugin = {
  id: "voxel-graph",
  name: "Agent World",
  version: "0.3.0",
  description:
    "Explore your vault as a living voxel archipelago: folders are islands, notes are villagers, wikilinks are bridges",
  canDisable: true,
  dependencies: ["wikilink", "core-indexer"],

  views: [
    {
      id: "voxel-graph.tab",
      label: "Agent",
      icon: "voxel",
      location: { slot: "centerTab" },
      tabType: VOXEL_TAB_TYPE,
      component: VoxelGraphTabView,
    },
    {
      id: VOXEL_PANEL_ID,
      label: "Agent",
      icon: "voxel",
      location: { slot: "rightPanel" },
      order: 12,
      component: VoxelGraphPanelView,
    },
    {
      id: "voxel-graph.settings",
      label: "Agent World",
      location: { slot: "settingsSection" },
      order: 40,
      component: VoxelGraphSettingsView,
    },
  ],

  commands: [
    {
      id: "voxel-graph.cycle",
      label: "Toggle Agent World",
      category: "Graph",
      defaultKeys: ["$mod+Shift+KeyG"],
      global: true,
      execute: () => {
        const voxelTab = filesState.tabs.find((t) => t.type === VOXEL_TAB_TYPE);
        const rightHasVoxel =
          layoutState.rightPanelOpen && layoutState.activeRightPanelViewId === VOXEL_PANEL_ID;

        if (voxelTab) {
          closeTab(voxelTab.id);
        } else if (rightHasVoxel) {
          openVoxelTab();
          closeRightPanelView();
        } else {
          openRightPanelView(VOXEL_PANEL_ID);
        }
      },
    },
  ],

  reset() {
    restoreVoxelRenderSettingsDefaults();
    getVoxelGraphStore()?.clear();
  },

  async activate(ctx) {
    await loadVoxelRenderSettings();

    const search = ctx.services.get("core-indexer.search") as SearchService | undefined;
    if (!search) {
      throw new Error("core-indexer.search service not found");
    }

    const store = createVoxelGraphStore({ service: search });
    setVoxelGraphStore(store);
    ctx.track(() => {
      setVoxelGraphStore(null);
      store.dispose();
    });
    ctx.services.register("store", store);

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

export { voxelGraphPlugin };
