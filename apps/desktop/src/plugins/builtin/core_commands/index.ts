// ── Core Commands Plugin ──
//
// Migrates all default app commands from keybindings/default_commands.ts
// into the plugin system. This is the simplest possible plugin: no UI,
// no editor contributions — just commands with keybindings.
//
// Commands:
//   panel.toggleLeft/Right/Bottom — panel visibility
//   tab.new/close/next/prev       — tab management
//   app.toggleTheme               — light/dark toggle
//   app.openSearch                 — open search tab
//   app.openSettings               — open settings tab
//   graph.cycle                    — graph panel/tab cycling

import {
  closeTab,
  createAndOpenNewFile,
  filesState,
  getActiveTab,
  nextTab,
  openTab,
  prevTab,
} from "~/stores/files";
import { layoutState, toggleBottomPanel, toggleLeftPanel, toggleRightPanel } from "~/stores/layout";
import { toggleTheme } from "~/stores/theme";
import { getContextKey } from "~/plugins/context_keys";
import type { KukuPlugin } from "~/plugins/types";

// ── Plugin Definition ──

const coreCommandsPlugin: KukuPlugin = {
  id: "core-commands",
  name: "Core Commands",
  version: "0.1.0",
  description: "Built-in app commands: panels, tabs, theme, search, settings, graph",

  commands: [
    // ── Panel ──

    {
      id: "panel.toggleLeft",
      label: "Toggle Left Panel",
      category: "Panel",
      defaultKeys: ["$mod+KeyB"],
      global: true,
      execute: () => toggleLeftPanel(),
      // When the editor is focused, $mod+B should trigger bold (Stage 4)
      // rather than toggling the panel. This guard yields the key to editor commands.
      when: () => getContextKey("editorTextFocus") !== true,
    },
    {
      id: "panel.toggleRight",
      label: "Toggle Right Panel",
      category: "Panel",
      defaultKeys: ["$mod+Shift+KeyB"],
      global: true,
      execute: () => toggleRightPanel(),
    },
    {
      id: "panel.toggleBottom",
      label: "Toggle Bottom Panel",
      category: "Panel",
      defaultKeys: ["$mod+KeyJ"],
      global: true,
      execute: () => toggleBottomPanel(),
    },

    // ── Tabs ──

    {
      id: "tab.new",
      label: "New Tab",
      category: "Tab",
      defaultKeys: ["$mod+KeyN"],
      global: true,
      execute: () => void createAndOpenNewFile(),
    },
    {
      id: "tab.close",
      label: "Close Tab",
      category: "Tab",
      defaultKeys: ["$mod+KeyW"],
      global: true,
      execute: () => {
        const tab = getActiveTab();
        if (tab) closeTab(tab.id);
      },
      canExecute: () => getActiveTab() !== undefined,
    },
    {
      id: "tab.next",
      label: "Next Tab",
      category: "Tab",
      defaultKeys: ["Control+Tab"],
      global: true,
      execute: () => nextTab(),
      when: () => filesState.tabs.length > 1,
    },
    {
      id: "tab.prev",
      label: "Previous Tab",
      category: "Tab",
      defaultKeys: ["Control+Shift+Tab"],
      global: true,
      execute: () => prevTab(),
      when: () => filesState.tabs.length > 1,
    },

    // ── App ──

    {
      id: "app.toggleTheme",
      label: "Toggle Theme",
      category: "App",
      defaultKeys: ["$mod+Shift+KeyT"],
      global: true,
      execute: () => toggleTheme(),
    },
    {
      id: "app.openSearch",
      label: "Open Search",
      category: "App",
      defaultKeys: ["$mod+Shift+KeyF"],
      global: true,
      execute: () => openTab("Search", null, "search"),
    },
    {
      id: "app.openSettings",
      label: "Open Settings",
      category: "App",
      defaultKeys: ["$mod+Comma"],
      global: true,
      execute: () => openTab("Settings", null, "settings"),
    },

    // ── Graph ──

    {
      id: "graph.cycle",
      label: "Toggle Graph",
      category: "Graph",
      defaultKeys: ["$mod+KeyG"],
      global: true,
      execute: () => {
        const graphTab = filesState.tabs.find((t) => t.type === "graph");

        if (graphTab) {
          // Graph tab open in center → close it
          closeTab(graphTab.id);
        } else if (layoutState.rightPanelOpen) {
          // Right panel showing graph → move to center tab, close panel
          openTab("Graph", null, "graph");
          toggleRightPanel();
        } else {
          // Nothing open → open right panel
          toggleRightPanel();
        }
      },
    },
  ],
};

// ── Exports ──

export { coreCommandsPlugin };
