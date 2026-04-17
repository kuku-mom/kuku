// ── Plugin Registry ──
//
// Core lifecycle manager for the plugin system.
// Handles registration, DAG validation, topological sort, and activation/deactivation.
//
// Design decisions (v1.3):
// - Register phase: stores metadata only, NO dependency validation (order-independent)
// - Validate phase: DAG check + missing deps + topological sort (called once in bootstrap)
// - Activate phase: cycle detection via `activating` Set, per-plugin try/catch isolation
// - Deactivate phase: reverse disposer execution (LIFO), cleanup all contributions
// - Failed guard: previously-failed plugins cannot be re-activated
//
// SolidJS module-level singleton — no Context provider needed.

import { createStore } from "solid-js/store";

import {
  usePluginExtension,
  buildNodeViewExtension,
} from "~/components/editor/system/editor_engine";
import { contributeMarkdown } from "~/plugins/markdown_service";
import { setActivationChecker, registerPluginCommand } from "~/plugins/commands";
import { deleteContextKeysByPrefix } from "~/plugins/context_keys";
import { removeListenersByPrefix } from "~/plugins/events";
import { registerFontPack } from "~/plugins/font_registry";
import { removeServicesByPrefix } from "~/plugins/services";
import { registerFill, removeFillsByPlugin } from "~/plugins/slots";
import { registerThemePack } from "~/plugins/theme_registry";
import type {
  Disposer,
  EditorContribution,
  KukuPlugin,
  PluginMeta,
  PluginRegistryState,
  SlotFill,
  ViewContribution,
  StatusBarContribution,
} from "~/plugins/types";

// ── Store ──

const [registryState, setRegistryState] = createStore<PluginRegistryState>({
  plugins: {},
  activated: [],
  disabled: [],
  failed: {},
});

// ── Internal (non-reactive) ──

const pluginInstances = new Map<string, KukuPlugin>();
const disposerMap = new Map<string, Disposer[]>();

/** Tracks plugins currently mid-activation to detect circular dependencies at runtime. */
const activating = new Set<string>();

// ── Wire up dependency injection ──
// Avoids circular dependency: commands.ts needs to check activation status,
// but commands.ts must not import registry.ts. Instead, we inject a checker.

setActivationChecker((pluginId) => registryState.activated.includes(pluginId));

// ── Public API ──

/**
 * Register a plugin. Stores its instance and indexes metadata into the reactive store.
 *
 * v1.3: NO dependency existence check here — plugins can be registered in any order.
 * Dependency validation happens later in `validateAndTopologicalSort()`.
 *
 * Contributions (commands, views, etc.) are NOT activated here — that happens
 * in `activatePlugin()`. Register only stores metadata for UI rendering
 * (e.g. the Plugins settings panel can list registered-but-not-yet-activated plugins).
 */
function registerPlugin(plugin: KukuPlugin): void {
  if (pluginInstances.has(plugin.id)) {
    // eslint-disable-next-line no-console
    console.warn(`[PluginRegistry] Plugin "${plugin.id}" already registered, skipping`);
    return;
  }

  pluginInstances.set(plugin.id, plugin);

  // Index metadata into reactive store (for UI)
  const meta: PluginMeta = {
    id: plugin.id,
    name: plugin.name,
    version: plugin.version,
    description: plugin.description,
    author: plugin.author,
    canDisable: plugin.canDisable ?? false,
    hasViews: (plugin.views?.length ?? 0) > 0,
    hasEditor: plugin.editor !== undefined,
    hasCommands: (plugin.commands?.length ?? 0) > 0,
    hasSettings: plugin.settings !== undefined,
    hasThemes: (plugin.themes?.length ?? 0) > 0,
  };

  setRegistryState("plugins", plugin.id, meta);
}

/**
 * Activate a plugin by ID.
 *
 * Activation order:
 * 1. Guard: already activated? already failed? circular?
 * 2. Recursively activate dependencies
 * 3. Register contributions (commands, views, status bar)
 * 4. Create PluginContext and call plugin.activate(ctx)
 * 5. Collect all disposers for deactivation cleanup
 *
 * If `plugin.activate()` throws, all contributions registered in this call
 * are rolled back (disposers executed in reverse order).
 */
async function activatePlugin(id: string): Promise<void> {
  // Already activated — no-op
  if (registryState.activated.includes(id)) return;

  if (registryState.disabled.includes(id)) {
    throw new Error(`Plugin "${id}" is disabled.`);
  }

  // Previously failed — refuse to retry (prevents cascading failures)
  if (registryState.failed[id]) {
    throw new Error(`Cannot activate plugin "${id}" because it previously failed to load.`);
  }

  // Circular dependency runtime detection
  if (activating.has(id)) {
    throw new Error(
      `Circular dependency detected: "${id}" is already being activated. ` +
        `Chain: ${[...activating].join(" → ")} → ${id}`,
    );
  }

  const plugin = pluginInstances.get(id);
  if (!plugin) {
    throw new Error(`Plugin "${id}" not registered`);
  }

  activating.add(id);
  try {
    // Activate dependencies first (recursive)
    for (const dep of plugin.dependencies ?? []) {
      await activatePlugin(dep);
    }

    const disposers: Disposer[] = [];

    // ── Register commands ──
    for (const cmd of plugin.commands ?? []) {
      const cmdDisposer = registerPluginCommand(id, cmd);
      disposers.push(cmdDisposer);
    }

    // ── Register view fills ──
    for (const view of plugin.views ?? []) {
      const viewDisposer = activateView(id, view);
      disposers.push(viewDisposer);
    }

    // ── Register status bar fills ──
    for (const item of plugin.statusBar ?? []) {
      const sbDisposer = activateStatusBar(id, item);
      disposers.push(sbDisposer);
    }

    // ── Register themes ──
    for (const theme of plugin.themes ?? []) {
      const themeDisposer = registerThemePack(theme);
      disposers.push(themeDisposer);
    }

    // ── Register fonts ──
    if (plugin.fonts) {
      const fontDisposer = registerFontPack(plugin.fonts);
      disposers.push(fontDisposer);
    }

    // ── Editor contribution ──
    if (plugin.editor) {
      const editorDisposer = activateEditorContribution(id, plugin.editor);
      disposers.push(editorDisposer);
    }

    // ── Create PluginContext and call activate() ──
    // Import dynamically to avoid circular dependency at module load time.
    // context.ts imports from commands/events/services/etc, not from registry.
    const { createPluginContext } = await import("~/plugins/context");
    const ctx = createPluginContext(id, (disposer) => disposers.push(disposer));

    try {
      const userDisposer = await plugin.activate?.(ctx);
      if (typeof userDisposer === "function") {
        disposers.push(userDisposer);
      }
    } catch (error) {
      // plugin.activate() failed — roll back all contributions registered so far
      // eslint-disable-next-line no-console
      console.error(`[PluginRegistry] Plugin "${id}" activate() threw:`, error);
      for (let i = disposers.length - 1; i >= 0; i--) {
        try {
          disposers[i]();
        } catch {
          // Swallow dispose errors during rollback
        }
      }
      throw error; // Re-throw so the caller can markPluginFailed
    }

    // Success — store disposers and mark as activated
    disposerMap.set(id, disposers);
    setRegistryState("activated", (prev) => [...prev, id]);
  } finally {
    activating.delete(id);
  }
}

/**
 * Deactivate a plugin by ID.
 * Calls `plugin.deactivate()`, then runs all tracked disposers in reverse order.
 * Also cleans up any leaked context keys, event listeners, and services.
 */
async function deactivatePlugin(id: string): Promise<void> {
  const plugin = pluginInstances.get(id);
  if (!plugin) return;

  // Call plugin's own deactivate hook
  try {
    await plugin.deactivate?.();
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`[PluginRegistry] Plugin "${id}" deactivate() threw:`, error);
  }

  // Run all disposers in reverse order (LIFO)
  const disposers = disposerMap.get(id) ?? [];
  for (let i = disposers.length - 1; i >= 0; i--) {
    try {
      disposers[i]();
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(`[PluginRegistry] Plugin "${id}" dispose error:`, error);
    }
  }
  disposerMap.delete(id);

  // Safety net cleanup (in case disposers missed something)
  removeFillsByPlugin(id);
  deleteContextKeysByPrefix(id);
  removeListenersByPrefix(`${id}:`);
  removeServicesByPrefix(`${id}.`);

  // Update state
  setRegistryState("activated", (prev) => prev.filter((x) => x !== id));
}

async function runPluginResets(): Promise<void> {
  for (const [id, plugin] of pluginInstances.entries()) {
    if (!plugin.reset) continue;
    try {
      await plugin.reset();
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(`[PluginRegistry] Plugin "${id}" reset() threw:`, error);
    }
  }
}

/**
 * Check if a plugin is currently activated.
 */
function isActivated(id: string): boolean {
  return registryState.activated.includes(id);
}

function setDisabledPlugins(pluginIds: string[]): void {
  setRegistryState("disabled", [...pluginIds]);
}

/**
 * Get a plugin instance by ID.
 */
function getPlugin(id: string): KukuPlugin | undefined {
  return pluginInstances.get(id);
}

function pluginDependsOn(id: string, targetId: string, seen = new Set<string>()): boolean {
  if (seen.has(id)) return false;
  seen.add(id);

  const plugin = pluginInstances.get(id);
  for (const dependencyId of plugin?.dependencies ?? []) {
    if (dependencyId === targetId) return true;
    if (pluginDependsOn(dependencyId, targetId, seen)) return true;
  }

  return false;
}

function getPluginDisplayOrder(): string[] {
  const { order } = validateAndTopologicalSort();
  const required = order.filter((id) => !(pluginInstances.get(id)?.canDisable ?? false));
  const optional = order.filter((id) => pluginInstances.get(id)?.canDisable ?? false);

  const sortWithinGroup = (ids: string[]) => {
    const topoIndex = new Map(ids.map((id, index) => [id, index]));

    return [...ids].sort((leftId, rightId) => {
      if (leftId === rightId) return 0;

      if (pluginDependsOn(leftId, rightId)) return 1;
      if (pluginDependsOn(rightId, leftId)) return -1;

      return (
        (topoIndex.get(leftId) ?? Number.MAX_SAFE_INTEGER) -
        (topoIndex.get(rightId) ?? Number.MAX_SAFE_INTEGER)
      );
    });
  };

  return [...sortWithinGroup(required), ...sortWithinGroup(optional)];
}

/**
 * Mark a plugin as failed. Stores the error message and timestamp.
 * Failed plugins are shown in the Settings UI with an error indicator.
 */
function markPluginFailed(id: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  setRegistryState("failed", id, { error: message, timestamp: Date.now() });
}

// ── DAG Validation & Topological Sort ──

interface ValidationResult {
  /** Safe activation order (dependencies come first). */
  order: string[];
  /** Human-readable error messages for missing deps and cycles. */
  errors: string[];
}

/**
 * Validate the dependency graph and compute a topological activation order.
 *
 * Performs two checks:
 * 1. Missing dependencies: plugin declares a dep that isn't registered
 * 2. Circular dependencies: A→B→C→A cycle detection via DFS
 *
 * Returns a topological sort order (post-order DFS) where dependencies
 * always appear before their dependents.
 *
 * Called once during bootstrap Phase 2, after all plugins are registered
 * but before any are activated.
 */
function validateAndTopologicalSort(): ValidationResult {
  const errors: string[] = [];
  const order: string[] = [];
  const visited = new Set<string>();
  const stack = new Set<string>(); // DFS recursion stack for cycle detection

  // 1. Check for missing dependencies
  for (const [id, plugin] of pluginInstances) {
    for (const dep of plugin.dependencies ?? []) {
      if (!pluginInstances.has(dep)) {
        errors.push(`Plugin "${id}": missing dependency "${dep}"`);
      }
    }
  }

  // 2. DFS-based cycle detection + topological sort (post-order)
  function dfs(id: string): void {
    if (stack.has(id)) {
      errors.push(`Circular dependency: ${[...stack].join(" → ")} → ${id}`);
      return;
    }
    if (visited.has(id)) return;

    stack.add(id);
    const plugin = pluginInstances.get(id);
    for (const dep of plugin?.dependencies ?? []) {
      // Only recurse into deps that are actually registered
      if (pluginInstances.has(dep)) {
        dfs(dep);
      }
    }
    stack.delete(id);
    visited.add(id);
    order.push(id); // Post-order: dependencies are pushed before dependents
  }

  for (const id of pluginInstances.keys()) {
    dfs(id);
  }

  return { order, errors };
}

// ── View/StatusBar Activation Helpers ──

/**
 * Convert a ViewContribution into a SlotFill and register it.
 */
function activateView(pluginId: string, view: ViewContribution): Disposer {
  const fill: SlotFill = {
    id: view.id,
    pluginId,
    slot: view.location.slot,
    label: view.label,
    icon: view.icon,
    component: view.component,
    order: view.order ?? 100,
    isActive: view.isActive ?? (() => true),
    tabType: view.tabType,
  };

  return registerFill(fill);
}

/**
 * Convert a StatusBarContribution into a SlotFill and register it in the bottomBar slot.
 */
function activateStatusBar(pluginId: string, item: StatusBarContribution): Disposer {
  const fill: SlotFill = {
    id: item.id,
    pluginId,
    slot: "bottomBar",
    label: "", // Status bar items don't have labels
    component: item.component,
    order: item.order ?? 100,
    isActive: item.isActive ?? (() => true),
    align: item.align,
  };

  return registerFill(fill);
}

// ── Editor Contribution Activation ──

/**
 * Activate a plugin's editor contribution.
 * Composes the main extension with any node view extensions,
 * then injects the result into the live editor via usePluginExtension().
 */
function activateEditorContribution(pluginId: string, contribution: EditorContribution): Disposer {
  // Build the main extension from the plugin's factory
  const ext = contribution.extension();

  // Node views are built async (dynamic import of prosekit/solid),
  // so we start with just the main extension and add node views when ready.
  const mainDisposer = usePluginExtension(pluginId, ext);
  const disposers: Disposer[] = [mainDisposer];

  // Track async node-view registration so the disposer can:
  //   1. cancel injection if the plugin deactivates before the build resolves
  //   2. dispose the late-arriving extension if it has already been injected
  let nodeViewDisposer: Disposer | undefined;
  let cancelled = false;

  if (contribution.nodeViews && Object.keys(contribution.nodeViews).length > 0) {
    buildNodeViewExtension(contribution.nodeViews)
      .then((nvExt) => {
        if (cancelled || !nvExt) return;
        nodeViewDisposer = usePluginExtension(`${pluginId}:nodeViews`, nvExt);
      })
      .catch((error) => {
        // eslint-disable-next-line no-console
        console.error(
          `[PluginRegistry] Plugin "${pluginId}" node view extension build failed:`,
          error,
        );
      });
  }

  // Markdown contribution
  if (contribution.markdown) {
    const mdDisposer = contributeMarkdown(pluginId, contribution.markdown);
    disposers.push(mdDisposer);
  }

  return () => {
    cancelled = true;
    nodeViewDisposer?.();
    for (const d of disposers) d();
  };
}

// ── Exports ──

export {
  activatePlugin,
  deactivatePlugin,
  getPlugin,
  getPluginDisplayOrder,
  isActivated,
  markPluginFailed,
  registerPlugin,
  registryState,
  runPluginResets,
  setDisabledPlugins,
  validateAndTopologicalSort,
};
export type { ValidationResult };
