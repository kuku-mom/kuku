// ── Event Bus ──
//
// Typed, loosely-coupled inter-plugin communication.
// Plugins emit and subscribe to events through `ctx.events`.
//
// Type safety via PluginEventMap (declaration merging):
//   - Built-in events are typed in types.ts
//   - Plugins extend the map in their own files:
//       declare module '~/plugins/types' {
//         interface PluginEventMap { 'my:event': { data: string } }
//       }
//   - Untyped events fall back to `unknown` data.
//
// SolidJS module-level singleton — no Context provider needed.

import type { Disposer, PluginEventMap } from "~/plugins/types";

// ── Types ──

type EventHandler<T = unknown> = (data: T) => void;

// ── State ──

const listeners = new Map<string, Set<EventHandler>>();

// ── API ──

/**
 * Emit a typed event (compile-time checked if event is in PluginEventMap).
 */
function emitEvent<K extends keyof PluginEventMap>(event: K, data: PluginEventMap[K]): void;
/**
 * Emit a custom event with unchecked data (fallback overload).
 */
function emitEvent(event: string, data?: unknown): void;
function emitEvent(event: string, data?: unknown): void {
  const handlers = listeners.get(event);
  if (!handlers || handlers.size === 0) return;

  for (const handler of handlers) {
    try {
      handler(data);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(`[EventBus] Handler error for "${event}":`, error);
    }
  }
}

/**
 * Subscribe to a typed event (compile-time checked).
 * Returns a disposer to unsubscribe.
 */
function onEvent<K extends keyof PluginEventMap>(
  event: K,
  handler: (data: PluginEventMap[K]) => void,
): Disposer;
/**
 * Subscribe to a custom event with unchecked data (fallback overload).
 */
function onEvent(event: string, handler: EventHandler): Disposer;
function onEvent(event: string, handler: EventHandler): Disposer {
  if (!listeners.has(event)) {
    listeners.set(event, new Set());
  }
  listeners.get(event)?.add(handler);

  return () => {
    listeners.get(event)?.delete(handler);
    // Clean up empty sets to avoid memory leaks
    if (listeners.get(event)?.size === 0) {
      listeners.delete(event);
    }
  };
}

/**
 * Check if any listeners are registered for an event.
 * Useful for skipping expensive data preparation when nobody is listening.
 */
function hasListeners(event: string): boolean {
  return (listeners.get(event)?.size ?? 0) > 0;
}

/**
 * Remove all listeners for events matching a prefix.
 * Used during plugin deactivation to clean up leaked subscriptions.
 *
 * Note: Normally, subscriptions are cleaned up via disposers tracked by
 * PluginContext. This is a safety net for edge cases.
 *
 * @param prefix — typically `{pluginId}:`, e.g. 'graph-view:'
 */
function removeListenersByPrefix(prefix: string): void {
  for (const key of listeners.keys()) {
    if (key.startsWith(prefix)) {
      listeners.delete(key);
    }
  }
}

// ── Exports ──

export { emitEvent, hasListeners, onEvent, removeListenersByPrefix };
