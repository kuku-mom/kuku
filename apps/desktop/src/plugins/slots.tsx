// ── Slot Registry ──
//
// UI Slot/Fill pattern for plugin-contributed views, panels, and widgets.
// Plugins register "fills" into named layout slots; the app renders them
// via the <Slot> component with per-fill ErrorBoundary isolation.
//
// Layout slots:
//   titleBarLeftAction  — top title bar actions near the left panel toggle
//   titleBarRightAction — top title bar actions near the right panel toggle
//   centerTab       — editor-area tabs (graph, search, etc.)
//   overlay         — app-wide overlays (omnibar, command palette)
//   leftSection     — left sidebar sections
//   rightPanel      — right panel tabs
//   bottomPanel     — bottom panel tabs (console, etc.)
//   bottomBar       — status bar widgets
//   settingsSection — settings page plugin sections
//
// SolidJS module-level singleton — no Context provider needed.

import { type Component, type JSX, ErrorBoundary, For, Show, Suspense, createMemo } from "solid-js";
import { Dynamic } from "solid-js/web";
import { createStore } from "solid-js/store";

import type { Disposer, SlotFill, SlotName } from "~/plugins/types";

// ── Store ──

const emptySlots: Record<SlotName, SlotFill[]> = {
  titleBarLeftAction: [],
  titleBarRightAction: [],
  centerTab: [],
  overlay: [],
  leftSection: [],
  rightPanel: [],
  bottomPanel: [],
  bottomBar: [],
  settingsSection: [],
};

const [slotRegistry, setSlotRegistry] = createStore<{
  fills: Record<SlotName, SlotFill[]>;
}>({
  fills: { ...emptySlots },
});

// ── API ──

/**
 * Register a fill into a named slot.
 * Fills are sorted by `order` within each slot (ascending).
 * Returns a disposer that removes the fill.
 */
function registerFill(fill: SlotFill): Disposer {
  setSlotRegistry("fills", fill.slot, (prev) =>
    [...prev.filter((entry) => entry.id !== fill.id), fill].sort((a, b) => a.order - b.order),
  );

  return () => {
    setSlotRegistry("fills", fill.slot, (prev) => prev.filter((f) => f.id !== fill.id));
  };
}

/**
 * Get all active fills for a slot.
 * Filters out fills whose `isActive()` returns false.
 */
function getFills(slot: SlotName): SlotFill[] {
  return slotRegistry.fills[slot].filter((f) => f.isActive());
}

/**
 * Get a specific fill by its `tabType` within the centerTab slot.
 * Used by the layout to resolve plugin-registered tab types.
 */
function getCenterTabFill(tabType: string): SlotFill | undefined {
  return slotRegistry.fills.centerTab.find((f) => f.tabType === tabType && f.isActive());
}

/**
 * Get a specific fill by its ID within a slot.
 * Used by the layout to resolve single active panel views.
 */
function getSlotFillById(slot: SlotName, id: string): SlotFill | undefined {
  return slotRegistry.fills[slot].find((f) => f.id === id && f.isActive());
}

/**
 * Get a right panel fill by its registered ID.
 * Right panel hosts one active fill at a time.
 */
function getRightPanelFill(viewId: string): SlotFill | undefined {
  return getSlotFillById("rightPanel", viewId);
}

/**
 * Remove all fills registered by a specific plugin.
 * Safety net for plugin deactivation (normally fills are cleaned up
 * via their disposers tracked by PluginContext).
 *
 * @param pluginId — ID of the plugin whose fills should be removed
 */
function removeFillsByPlugin(pluginId: string): void {
  const slotNames = Object.keys(slotRegistry.fills) as SlotName[];
  for (const slot of slotNames) {
    setSlotRegistry("fills", slot, (prev) => prev.filter((f) => f.pluginId !== pluginId));
  }
}

// ── Error UI ──

/**
 * Fallback UI shown when a plugin's slot fill crashes.
 * Displays the plugin ID, error message, and a retry button.
 */
function PluginErrorUI(props: {
  pluginId: string;
  error: Error;
  onReset: () => void;
}): JSX.Element {
  return (
    <div class="flex flex-col items-center justify-center gap-2 p-4 text-center">
      <p class="text-[0.75rem] font-medium text-text-muted">Plugin "{props.pluginId}" crashed</p>
      <p class="max-w-75 truncate text-[0.6875rem] text-text-muted">
        {props.error?.message ?? "Unknown error"}
      </p>
      <button
        type="button"
        class="cursor-pointer rounded-xs border border-border bg-bg-secondary px-2 py-0.5 text-[0.6875rem] text-text-secondary hover:bg-bg-tertiary"
        onClick={props.onReset}
      >
        Retry
      </button>
    </div>
  );
}

/**
 * Loading placeholder shown while a lazy-loaded plugin component is fetched.
 */
function PluginSkeleton(): JSX.Element {
  return <div class="size-full animate-pulse bg-bg-secondary" />;
}

// ── <Slot> Component ──

interface SlotProps {
  /** Which layout slot to render fills for. */
  name: SlotName;
  /** Fallback content when no active fills exist. */
  fallback?: JSX.Element;
}

/**
 * Renders all active fills for a named slot.
 *
 * Each fill is wrapped in:
 * - `<ErrorBoundary>` — plugin crash doesn't take down the app
 * - `<Suspense>` — supports lazy-loaded plugin components
 *
 * @example
 * ```tsx
 * <Slot name="bottomPanel" fallback={<EmptyState />} />
 * ```
 */
const Slot: Component<SlotProps> = (props) => {
  // Memoized so the `Show when` and `For each` reads share one filtered
  // array per render — `f.isActive()` is potentially expensive in plugins.
  const activeFills = createMemo(() => slotRegistry.fills[props.name].filter((f) => f.isActive()));

  return (
    <Show when={activeFills().length > 0} fallback={props.fallback}>
      <For each={activeFills()}>
        {(fill) => (
          <ErrorBoundary
            fallback={(err: Error, reset: () => void) => (
              <PluginErrorUI pluginId={fill.pluginId} error={err} onReset={reset} />
            )}
          >
            <Suspense fallback={<PluginSkeleton />}>
              <Dynamic component={fill.component} />
            </Suspense>
          </ErrorBoundary>
        )}
      </For>
    </Show>
  );
};

// ── Exports ──

export {
  getCenterTabFill,
  getFills,
  getRightPanelFill,
  PluginErrorUI,
  PluginSkeleton,
  registerFill,
  removeFillsByPlugin,
  Slot,
  slotRegistry,
};
