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
// Design: v1.3 §4.6

import { initAppPaths } from "~/plugins/app_paths";
import {
  activatePlugin,
  markPluginFailed,
  registerPlugin,
  registryState,
  validateAndTopologicalSort,
} from "~/plugins/registry";
import { destroyKeymap } from "~/plugins/commands";
import type { KukuPlugin } from "~/plugins/types";

// ── Built-in Plugins ──

import { coreCommandsPlugin } from "~/plugins/builtin/core_commands";

/**
 * All built-in plugins, listed in no particular order.
 * Registration is order-independent (v1.3: no deps check at register time).
 */
const builtinPlugins: KukuPlugin[] = [
  coreCommandsPlugin,
  // Stage 4: editorCorePlugin
  // Stage 5: defaultThemePlugin, defaultIconsPlugin
  // Stage 5: graphViewPlugin, searchPlugin, consolePlugin
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
  // TODO (Stage 5): read from ~/.kuku/settings.json → disabledPlugins[]
  return [];
}

// ── Exports ──

export { bootstrapPlugins, destroyPlugins };
