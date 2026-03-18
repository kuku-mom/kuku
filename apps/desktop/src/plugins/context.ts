// ── Plugin Context Factory ──
//
// Creates a PluginContext instance for each plugin during activation.
// Combines all plugin registries (commands, events, services, context keys)
// with existing app stores (files, layout) and Rust-backed APIs (fs, settings).
//
// All registrations (commands, events, services) made through the context
// are automatically tracked via the `trackDisposer` callback. When the plugin
// is deactivated, all tracked disposers are called in reverse order (LIFO).

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { getAppRoot, getPluginDataDir, getPluginSettingsPath } from "~/plugins/app_paths";
import { registerPluginCommand, executePluginCommand } from "~/plugins/commands";
import { setContextKey, getContextKey } from "~/plugins/context_keys";
import { emitEvent, onEvent } from "~/plugins/events";
import { registerService, getService } from "~/plugins/services";
import {
  getActiveEditorInstance,
  usePluginExtension,
} from "~/components/editor/system/editor_engine";
import { closeTab, filesState, getActiveTab, openTab } from "~/stores/files";
import { layoutState, toggleBottomPanel, toggleLeftPanel, toggleRightPanel } from "~/stores/layout";
import {
  listVaultFiles,
  readVaultFile,
  readVaultFileWithChecksum,
  vaultExists,
  type FileChangeEvent,
  writeVaultFile,
  writeVaultFileWithChecksum,
} from "~/lib/vault_fs";
import { vaultState } from "~/stores/vault";
import type { Disposer, PluginContext, PluginEventMap } from "~/plugins/types";

// ── Factory ──

/**
 * Create a PluginContext for a specific plugin.
 *
 * @param pluginId — the plugin's unique ID
 * @param trackDisposer — callback to register disposers for auto-cleanup on deactivation
 */
function createPluginContext(
  pluginId: string,
  trackDisposer: (disposer: Disposer) => void,
): PluginContext {
  const appRoot = getAppRoot();
  const pluginData = getPluginDataDir(pluginId);

  return {
    pluginId,

    // ── Paths ──

    paths: {
      appRoot,
      pluginData,
      pluginSettings: getPluginSettingsPath(pluginId),
    },

    // ── File System (Rust-backed, sandboxed, relative paths only) ──

    fs: {
      readFile: (rel) => invoke("plugin_fs_read_text", { pluginId, path: rel }),
      writeFile: (rel, content) => invoke("plugin_fs_write_text", { pluginId, path: rel, content }),
      readBinary: (rel) => invoke("plugin_fs_read_binary", { pluginId, path: rel }),
      writeBinary: (rel, data) =>
        invoke("plugin_fs_write_binary", { pluginId, path: rel, data: [...data] }),
      exists: (rel) => invoke("plugin_fs_exists", { pluginId, path: rel }),
      mkdir: (rel) => invoke("plugin_fs_mkdir", { pluginId, path: rel }),
      readDir: (rel) => invoke("plugin_fs_read_dir", { pluginId, path: rel }),
      remove: (rel) => invoke("plugin_fs_remove", { pluginId, path: rel }),
    },

    // ── Vault (user document files — uses existing stores) ──

    vault: {
      get rootPath() {
        return vaultState.rootPath;
      },
      readFile: (path) => readVaultFile(path),
      writeFile: (path, content) => writeVaultFile(path, content),
      readFileWithChecksum: (path) => readVaultFileWithChecksum(path),
      writeFileWithChecksum: (path, content, checksum) =>
        writeVaultFileWithChecksum(path, content, checksum),
      listFiles: (path) => listVaultFiles(path ?? ""),
      exists: (path) => vaultExists(path),
      onFileChanged: async (callback) => {
        const unlisten = await listen<FileChangeEvent>("vault:file-changed", (event) => {
          callback(event.payload);
        });
        const dispose = () => unlisten();
        trackDisposer(dispose);
        return dispose;
      },
    },

    // ── Editor (ProseKit-backed via editor_engine) ──

    editor: {
      get instance() {
        return getActiveEditorInstance();
      },
      get activeFilePath() {
        return getActiveTab()?.filePath ?? null;
      },
      use(extension) {
        const dispose = usePluginExtension(pluginId, extension);
        trackDisposer(dispose);
        return dispose;
      },
      get hasSelection() {
        const editor = getActiveEditorInstance();
        if (!editor?.view) return false;
        return !editor.view.state.selection.empty;
      },
      getTextContent() {
        const editor = getActiveEditorInstance();
        if (!editor?.view) return null;
        return editor.view.state.doc.textContent;
      },
      getSelectedText() {
        const editor = getActiveEditorInstance();
        if (!editor?.view) return null;
        const { from, to } = editor.view.state.selection;
        if (from === to) return null;
        return editor.view.state.doc.textBetween(from, to);
      },
    },

    // ── Tabs ──

    tabs: {
      get activeTab() {
        return getActiveTab() ?? null;
      },
      get allTabs() {
        return filesState.tabs;
      },
      open: (fileName, filePath, type) => {
        openTab(fileName, filePath ?? null, (type ?? "editor") as "editor");
      },
      close: (tabId) => closeTab(tabId),
    },

    // ── Layout ──

    layout: {
      get leftPanelOpen() {
        return layoutState.leftPanelOpen;
      },
      get rightPanelOpen() {
        return layoutState.rightPanelOpen;
      },
      get bottomPanelOpen() {
        return layoutState.bottomPanelOpen;
      },
      toggleLeft: () => toggleLeftPanel(),
      toggleRight: () => toggleRightPanel(),
      toggleBottom: () => toggleBottomPanel(),
    },

    // ── Commands ──

    commands: {
      register(cmd) {
        const dispose = registerPluginCommand(pluginId, cmd);
        trackDisposer(dispose);
        return dispose;
      },
      execute: (commandId) => executePluginCommand(commandId),
    },

    // ── Events (typed, inter-plugin communication) ──

    events: {
      emit: (event: string, data?: unknown) => {
        emitEvent(event as keyof PluginEventMap, data as never);
      },
      on(event: string, handler: (data: unknown) => void) {
        const dispose = onEvent(event as keyof PluginEventMap, handler as never);
        trackDisposer(dispose);
        return dispose;
      },
    } as PluginContext["events"],

    // ── Services (strong coupling, requires dependency declaration) ──

    services: {
      register(name, service) {
        const qualifiedName = `${pluginId}.${name}`;
        const dispose = registerService(qualifiedName, service);
        trackDisposer(dispose);
        return dispose;
      },
      get: (name) => getService(name),
    },

    // ── Context Keys (reactive when conditions) ──

    context: {
      set: (key, value) => setContextKey(`${pluginId}.${key}`, value),
      get: (key) => getContextKey(key),
    },

    // ── Disposer tracking ──

    track: trackDisposer,
  };
}

// ── Exports ──

export { createPluginContext };
