// ── Agent World Plugin ──
//
// A graph-view alternative that renders wikilink nodes as wandering voxel
// blocks in a bounded Three.js space. It owns its own graph store so it can be
// enabled/disabled independently from the standard Graph View plugin.

import { lazy } from "solid-js";

import type { SearchService } from "~/plugins/builtin/core_indexer/service";
import type { KukuPlugin } from "~/plugins/types";
import { closeTab, filesState, getActiveTab, openTab } from "~/stores/files";
import { closeRightPanelView, layoutState, openRightPanelView } from "~/stores/layout";

import { createVoxelGraphStore, getVoxelGraphStore, setVoxelGraphStore } from "./voxel_store";

const VoxelGraphTabView = lazy(() => import("./voxel_tab"));
const VoxelGraphPanelView = lazy(() => import("./voxel_panel"));

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
  version: "0.1.0",
  description: "Explore wikilink connections as an animated agent world in 3D space",
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
    getVoxelGraphStore()?.clear();
  },

  async activate(ctx) {
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
