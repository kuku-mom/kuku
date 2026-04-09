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

import { closeTab, filesState, getActiveTab, nextTab, openSettings, prevTab } from "~/stores/files";
import { toggleBottomPanel, toggleLeftPanel, toggleRightPanel } from "~/stores/layout";
import { setEditorSetting, settingsState, SETTING_DEFAULTS } from "~/stores/settings";
import { toggleTheme } from "~/stores/theme";
import { createAndOpenNewFile } from "~/stores/vault";
import type { AiProxyToolRegistry } from "~/plugins/builtin/core_tool_registry/types";
import { getContextKey } from "~/plugins/context_keys";
import type { KukuPlugin } from "~/plugins/types";

const FONT_SIZE_MIN = 12;
const FONT_SIZE_MAX = 32;
const FONT_SIZE_STEP = 1;

// ── Plugin Definition ──

const coreCommandsPlugin: KukuPlugin = {
  id: "core-commands",
  name: "Core Commands",
  version: "0.1.0",
  description: "Built-in app commands: panels, tabs, theme, search, settings",
  dependencies: ["core-tool-registry"],

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
      id: "app.openSettings",
      label: "Open Settings",
      category: "App",
      defaultKeys: ["$mod+Comma"],
      global: true,
      execute: () => openSettings(),
    },

    // ── Font Size ──

    {
      id: "editor.zoomIn",
      label: "Zoom In",
      category: "Editor",
      defaultKeys: ["$mod+Equal"],
      global: true,
      execute: () => {
        const next = Math.min(settingsState.editor.fontSize + FONT_SIZE_STEP, FONT_SIZE_MAX);
        setEditorSetting("fontSize", next);
      },
    },
    {
      id: "editor.zoomOut",
      label: "Zoom Out",
      category: "Editor",
      defaultKeys: ["$mod+Minus"],
      global: true,
      execute: () => {
        const next = Math.max(settingsState.editor.fontSize - FONT_SIZE_STEP, FONT_SIZE_MIN);
        setEditorSetting("fontSize", next);
      },
    },
    {
      id: "editor.zoomReset",
      label: "Reset Zoom",
      category: "Editor",
      defaultKeys: ["$mod+Digit0"],
      global: true,
      execute: () => {
        setEditorSetting("fontSize", SETTING_DEFAULTS.editor.fontSize);
      },
    },
  ],

  activate(ctx) {
    const proxyTools = ctx.services.get<AiProxyToolRegistry>("core-tool-registry.proxyTools");
    if (!proxyTools) {
      return;
    }

    const dispose = proxyTools.register({
      name: "open_file",
      toolId: `${ctx.pluginId}.open_file`,
      description:
        "Open a vault file in an editor tab. This is a navigation action, not a mutation.",
      category: "navigation",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Vault-relative file path to open" },
        },
        required: ["path"],
      },
      handler: async (args) => {
        const path = normalizeVaultPath(typeof args.path === "string" ? args.path : "");
        if (!path) {
          throw new Error("path is required");
        }

        const exists = await ctx.vault.exists(path);
        if (!exists) {
          throw new Error(`File does not exist: ${path}`);
        }

        ctx.tabs.open(baseName(path), path, "editor");
        return JSON.stringify({ ok: true, path }, null, 2);
      },
    });

    ctx.track(dispose);
  },
};

function normalizeVaultPath(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "." || trimmed === "./") {
    return "";
  }

  return trimmed.replace(/^\.\//, "").replace(/^\/+/, "").replace(/\/+$/, "");
}

function baseName(path: string): string {
  return path.split("/").at(-1) ?? path;
}

// ── Exports ──

export { coreCommandsPlugin };
