// ── Plugin Bootstrap ──
//
// App startup sequence for the plugin system.
// Called once in app.tsx onMount, before any plugin-dependent UI renders.
//
// Phases:
//   0. Initialize ~/.kuku directory structure
//   1. Register all built-in plugins (order-independent, no validation)
//   2. Validate dependency graph (missing deps + cycle detection + topological sort)
//   3. Activate in topological order (per-plugin try/catch isolation)
//
// The `pluginsReady` signal gates editor rendering — MarkdownEditor must
// wait for all plugins (especially editor-core with its schema-defining
// mark/node specs) to be activated before calling createKukuEditor().
// This is because ProseKit requires all schema extensions at createEditor()
// time; editor.use() cannot add node/mark specs after creation.
//
// Design: v1.3 §4.6

import { createSignal } from "solid-js";

import { initAppPaths } from "~/plugins/app_paths";
import { coreToolRegistryPlugin } from "~/plugins/builtin/core_tool_registry";
import { coreAuthPlugin } from "~/plugins/builtin/core_auth";
import { coreIndexerPlugin } from "~/plugins/builtin/core_indexer";
import { coreCommandsPlugin } from "~/plugins/builtin/core_commands";
import { aiChatPlugin } from "~/plugins/builtin/ai_chat";
import { editorCorePlugin } from "~/plugins/builtin/editor_core";
import { graphViewPlugin } from "~/plugins/builtin/graph_view";
import { searchPlugin } from "~/plugins/builtin/search";
import { wikilinkPlugin } from "~/plugins/builtin/wikilink";
import { themeDefaultPlugin } from "~/plugins/builtin/theme_default";
import { typographyPlugin } from "~/plugins/builtin/typography";
import { destroyKeymap } from "~/plugins/commands";
import { buildMarkdownService } from "~/plugins/markdown_service";
import {
  activatePlugin,
  markPluginFailed,
  registerPlugin,
  registryState,
  setDisabledPlugins,
  validateAndTopologicalSort,
} from "~/plugins/registry";
import { settingsState } from "~/stores/settings";
import type { KukuPlugin } from "~/plugins/types";

// ── Ready Signal ──

/**
 * Reactive signal that becomes `true` after all plugins are activated.
 * Components that depend on plugin contributions (especially the editor)
 * must gate their rendering on this signal:
 *
 * ```tsx
 * <Show when={pluginsReady()}>
 *   <MarkdownEditor />
 * </Show>
 * ```
 */
const [pluginsReady, setPluginsReady] = createSignal(false);

// ── Built-in Plugins ──

/**
 * All built-in plugins, listed in no particular order.
 * Registration is order-independent (v1.3: no deps check at register time).
 */
const builtinPlugins: KukuPlugin[] = [
  coreToolRegistryPlugin,
  coreAuthPlugin,
  coreCommandsPlugin,
  coreIndexerPlugin,
  aiChatPlugin,
  editorCorePlugin,
  wikilinkPlugin,
  graphViewPlugin,
  searchPlugin,
  themeDefaultPlugin,
  typographyPlugin,
  // Future: consolePlugin
];

// ── Bootstrap ──

/**
 * Initialize the plugin system and activate all built-in plugins.
 *
 * This is the main entry point — call once during app startup.
 * Safe to call multiple times (idempotent via initAppPaths guard).
 */
async function bootstrapPlugins(): Promise<void> {
  // Phase 0: Ensure ~/.kuku/ and ~/.kuku/plugins/ exist
  await initAppPaths();

  // Phase 1: Register all built-in plugins
  for (const plugin of builtinPlugins) {
    try {
      registerPlugin(plugin);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(`[Bootstrap] Failed to register "${plugin.id}":`, error);
    }
  }

  // Phase 2: Validate dependency graph + compute activation order
  const { order, errors } = validateAndTopologicalSort();

  for (const err of errors) {
    // eslint-disable-next-line no-console
    console.error(`[Bootstrap] Dependency error: ${err}`);
  }

  // Phase 3: Activate in topological order
  const disabled = loadDisabledPlugins();
  setDisabledPlugins(disabled);

  for (const id of order) {
    // Skip user-disabled plugins
    if (disabled.includes(id)) continue;

    // Skip plugins whose dependencies failed or weren't activated
    const plugin = registryState.plugins[id];
    if (!plugin) continue;

    try {
      await activatePlugin(id);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(`[Bootstrap] Failed to activate "${id}":`, error);
      markPluginFailed(id, error);
    }
  }

  // eslint-disable-next-line no-console
  console.debug(
    `[Bootstrap] Done. Activated: ${registryState.activated.length}/${order.length} plugins`,
  );

  // Phase 3.5: Build markdown service from collected contributions
  // [R2] Order guarantee: buildMarkdownService() completes before pluginsReady
  // → MarkdownEditor mount point always has a valid service
  buildMarkdownService();

  // Signal that all plugins are ready — editor can now mount safely
  setPluginsReady(true);
}

/**
 * Tear down the plugin system. Called during app cleanup.
 */
function destroyPlugins(): void {
  destroyKeymap();
}

// ── Helpers ──

/**
 * Load the list of user-disabled plugin IDs from settings.
 * For now returns an empty array — will integrate with settings store in Stage 5.
 */
function loadDisabledPlugins(): string[] {
  return settingsState.disabledPlugins.filter((id) => registryState.plugins[id]?.canDisable);
}

// ── Exports ──

export { bootstrapPlugins, destroyPlugins, pluginsReady };
