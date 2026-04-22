// ── Service Registry ──
//
// Strong-coupling inter-plugin communication via named services.
// A plugin registers a service object (e.g. an AI API), and other plugins
// consume it via `ctx.services.get()`.
//
// Consumers MUST declare the provider in their `dependencies` array to
// guarantee activation order and service availability.
//
// SolidJS module-level singleton — no Context provider needed.

import type { Disposer } from "~/plugins/types";

// ── State ──

const services = new Map<string, unknown>();

// ── API ──

/**
 * Register a named service. Returns a disposer that removes it.
 *
 * Convention: service names are prefixed with the plugin ID:
 *   `ctx.services.register('ai', impl)` → stored as `{pluginId}.ai`
 *
 * If a service with the same name already exists, it is overwritten
 * with a warning. This allows hot-reloading during development.
 */
function registerService(name: string, service: unknown): Disposer {
  if (services.has(name)) {
    // eslint-disable-next-line no-console
    console.warn(`[ServiceRegistry] Service "${name}" already registered, overwriting`);
  }
  services.set(name, service);

  return () => {
    // Only delete if it's still the same reference (avoid race with re-register)
    if (services.get(name) === service) {
      services.delete(name);
    }
  };
}

/**
 * Get a named service. Returns `undefined` if not registered.
 *
 * Callers should have the provider plugin in their `dependencies` to ensure
 * the service is available by the time `activate()` runs.
 *
 * Returns `unknown` — callers cast to the expected service type. Since
 * the registry is keyed by string, there's no way to map names to types
 * without a global service registry, so the cast lives at the callsite.
 *
 * @example
 * ```ts
 * const ai = ctx.services.get('ai-chat.ai') as AIService | undefined;
 * if (ai) {
 *   const response = await ai.chat('Hello');
 * }
 * ```
 */
function getService(name: string): unknown {
  return services.get(name);
}

/**
 * Check if a service is registered.
 */
function hasService(name: string): boolean {
  return services.has(name);
}

/**
 * Remove all services whose name starts with the given prefix.
 * Used during plugin deactivation as a safety net (normally services
 * are cleaned up via their disposers tracked by PluginContext).
 *
 * @param prefix — typically `{pluginId}.`, e.g. 'ai-chat.'
 */
function removeServicesByPrefix(prefix: string): void {
  for (const key of services.keys()) {
    if (key.startsWith(prefix)) {
      services.delete(key);
    }
  }
}

// ── Exports ──

export { getService, hasService, registerService, removeServicesByPrefix };
