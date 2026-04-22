// ── Context Keys ──
//
// Reactive key-value store used for `when` conditions on commands, menus, etc.
// Plugins set context keys via `ctx.context.set(key, value)` and read them
// via `ctx.context.get(key)` or directly in `when: () => getContextKey(...) === true`.
//
// SolidJS module-level singleton — fine-grained reactivity without Context providers.

import { createStore } from "solid-js/store";

// ── Store ──

const [contextKeys, setContextKeys] = createStore<Record<string, unknown>>({});

// ── API ──

/**
 * Set a context key value. Triggers reactive updates in any `when` condition
 * that reads this key.
 *
 * Plugin-scoped keys should be prefixed with the plugin ID:
 *   `ctx.context.set('myFeature', true)` → stored as `{pluginId}.myFeature`
 *
 * Built-in keys (set by the app core) use unprefixed names:
 *   `setContextKey('editorTextFocus', true)`
 */
function setContextKey(key: string, value: unknown): void {
  setContextKeys(key, value);
}

/**
 * Get a context key value. Returns `undefined` if the key has not been set.
 *
 * Inside a reactive scope (e.g. a `when` function), reading a key will
 * automatically subscribe to changes via SolidJS fine-grained tracking.
 *
 * Returns `unknown` — callers cast to the expected type. There's no way
 * to type this generically without pre-registering every key, so keeping
 * the cast at the callsite keeps the contract honest.
 */
function getContextKey(key: string): unknown {
  return contextKeys[key];
}

/**
 * Delete a context key. Equivalent to setting it to `undefined`.
 */
function deleteContextKey(key: string): void {
  setContextKeys(key, undefined);
}

/**
 * Delete all context keys that start with a given prefix.
 * Used during plugin deactivation to clean up all keys set by a plugin.
 *
 * @param prefix — typically the plugin ID, e.g. 'graph-view'
 */
function deleteContextKeysByPrefix(prefix: string): void {
  const dotPrefix = `${prefix}.`;
  const keysToDelete = Object.keys(contextKeys).filter((k) => k.startsWith(dotPrefix));
  for (const key of keysToDelete) {
    setContextKeys(key, undefined);
  }
}

// ── Exports ──

export { contextKeys, deleteContextKey, deleteContextKeysByPrefix, getContextKey, setContextKey };
