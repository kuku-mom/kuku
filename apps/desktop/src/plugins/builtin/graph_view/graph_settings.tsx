// ── Graph Settings ──
//
// Module-level reactive store for graph view settings.
// Provides `getGraphSettings()` for canvas/components to read,
// and `GraphSettingsPanel` as a settings section UI component.
//
// SolidJS design:
//   - `createStore` at module level → fine-grained reactivity
//   - Canvas reads `getGraphSettings().chargeStrength` etc. inside
//     paint callbacks → current value without subscriptions (correct
//     for rAF-driven code outside tracking scope)
//   - JSX reads inside tracking scope → auto-updates on change

import { type JSX, For, Show } from "solid-js";
import { createStore, reconcile, unwrap } from "solid-js/store";

import Switch from "~/components/ui/switch";
import { loadPluginSettings, savePluginSettings } from "~/plugins/settings_store";

import { GRAPH_SETTINGS_DEFAULTS, mergeGraphSettings, type GraphSettings } from "./graph_types";

const GRAPH_SETTINGS_PLUGIN_ID = "graph-view";

// ── Reactive Store (module-level singleton) ──────────────────

const [settings, setSettings] = createStore<GraphSettings>({ ...GRAPH_SETTINGS_DEFAULTS });

/** Read the current graph settings. Fine-grained reactive in JSX. */
function getGraphSettings(): GraphSettings {
  return settings;
}

/** Update a single setting key. */
function updateGraphSetting<K extends keyof GraphSettings>(key: K, value: GraphSettings[K]): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (setSettings as any)(key, value);
  void persistSettings();
}

/** Reset all settings to defaults. */
function resetGraphSettings(): void {
  restoreGraphSettingsDefaults();
  void persistSettings();
}

function restoreGraphSettingsDefaults(): void {
  setSettings(reconcile({ ...GRAPH_SETTINGS_DEFAULTS }));
}

/** Load persisted settings from Rust backend. */
async function loadGraphSettings(): Promise<void> {
  try {
    const next = await loadPluginSettings<GraphSettings>({
      pluginId: GRAPH_SETTINGS_PLUGIN_ID,
      defaults: GRAPH_SETTINGS_DEFAULTS,
      normalize: (raw) => mergeGraphSettings(raw),
    });
    setSettings(reconcile(next));
  } catch {
    // First launch or missing file — defaults are fine
    restoreGraphSettingsDefaults();
  }
}

async function persistSettings(): Promise<void> {
  try {
    await savePluginSettings(GRAPH_SETTINGS_PLUGIN_ID, unwrap(settings));
  } catch {
    // Silently ignore persist failures
  }
}

// ── Field Descriptors ────────────────────────────────────────

interface FieldDesc {
  key: keyof GraphSettings;
  label: string;
  min: number;
  max: number;
  step: number;
  type: "range" | "toggle";
}

interface SectionDesc {
  title: string;
  fields: FieldDesc[];
}

const SECTIONS: SectionDesc[] = [
  {
    title: "Forces",
    fields: [
      { key: "chargeStrength", label: "Repulsion", min: -500, max: -10, step: 10, type: "range" },
      {
        key: "chargeStrengthOrphan",
        label: "Orphan repulsion",
        min: -300,
        max: -10,
        step: 5,
        type: "range",
      },
      {
        key: "linkDistanceSameFolder",
        label: "Link distance (same folder)",
        min: 10,
        max: 300,
        step: 5,
        type: "range",
      },
      {
        key: "linkDistanceCrossFolder",
        label: "Link distance (cross folder)",
        min: 50,
        max: 500,
        step: 10,
        type: "range",
      },
      { key: "centerStrength", label: "Center pull", min: 0, max: 0.5, step: 0.005, type: "range" },
      {
        key: "clusterStrength",
        label: "Cluster pull",
        min: 0,
        max: 1,
        step: 0.05,
        type: "range",
      },
      {
        key: "clusterRadiusFactor",
        label: "Cluster spread",
        min: 0.1,
        max: 0.8,
        step: 0.05,
        type: "range",
      },
    ],
  },
  {
    title: "Simulation",
    fields: [
      {
        key: "alphaDecay",
        label: "Cooling rate",
        min: 0.001,
        max: 0.1,
        step: 0.001,
        type: "range",
      },
      {
        key: "velocityDecay",
        label: "Velocity damping",
        min: 0.05,
        max: 0.8,
        step: 0.05,
        type: "range",
      },
      { key: "warmupTicks", label: "Warmup ticks", min: 0, max: 300, step: 10, type: "range" },
      { key: "cooldownTicks", label: "Max ticks", min: 50, max: 1000, step: 50, type: "range" },
    ],
  },
  {
    title: "Node Sizing",
    fields: [
      { key: "nodeMinSize", label: "Min size", min: 1, max: 10, step: 0.5, type: "range" },
      { key: "nodeMaxSize", label: "Max size", min: 5, max: 30, step: 0.5, type: "range" },
      { key: "nodeSizeScale", label: "Size per link", min: 0.1, max: 3, step: 0.1, type: "range" },
      { key: "orphanNodeSize", label: "Orphan size", min: 1, max: 10, step: 0.5, type: "range" },
    ],
  },
  {
    title: "Links",
    fields: [
      { key: "linkCurvature", label: "Curvature", min: 0, max: 0.5, step: 0.01, type: "range" },
      { key: "arrowLength", label: "Arrow length", min: 0, max: 10, step: 0.5, type: "range" },
    ],
  },
  {
    title: "Clusters",
    fields: [
      {
        key: "clusterPadding",
        label: "Cluster padding",
        min: 10,
        max: 150,
        step: 5,
        type: "range",
      },
      { key: "showClusters", label: "Show clusters", min: 0, max: 1, step: 1, type: "toggle" },
    ],
  },
  {
    title: "Backlinks",
    fields: [
      { key: "showBacklinks", label: "Show backlinks", min: 0, max: 1, step: 1, type: "toggle" },
    ],
  },
];

// ── Formatting helper ────────────────────────────────────────

function formatValue(value: number, step: number): string {
  if (step >= 1) return String(Math.round(value));
  const decimals = Math.max(0, -Math.floor(Math.log10(step)));
  return value.toFixed(decimals);
}

// ── Settings Panel Component ─────────────────────────────────

function GraphSettingsPanel(): JSX.Element {
  return (
    <div class="space-y-3 p-4">
      {/* Header */}
      <div class="flex items-center justify-between">
        <div>
          <h3 class="text-[0.8125rem] font-medium text-text-primary">Graph View</h3>
          <p class="mt-0.5 text-[0.75rem] text-text-muted">
            Configure forces, simulation, and visual properties.
          </p>
        </div>
        <button
          type="button"
          class="rounded-xs border border-border bg-bg-secondary px-2.5 py-1 text-[0.6875rem] text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
          onClick={resetGraphSettings}
        >
          Reset All
        </button>
      </div>

      {/* Sections */}
      <For each={SECTIONS}>
        {(section) => (
          <div class="rounded-xs border border-border bg-bg-primary">
            <div class="border-b border-border px-3 py-2">
              <span class="text-[0.6875rem] font-medium tracking-wide text-text-secondary uppercase">
                {section.title}
              </span>
            </div>
            <div class="space-y-0 divide-y divide-border/50">
              <For each={section.fields}>
                {(field) => (
                  <Show when={field.type === "toggle"} fallback={<RangeRow field={field} />}>
                    <ToggleRow field={field} />
                  </Show>
                )}
              </For>
            </div>
          </div>
        )}
      </For>
    </div>
  );
}

// ── Row Components ───────────────────────────────────────────

function RangeRow(props: { field: FieldDesc }): JSX.Element {
  const value = () => settings[props.field.key] as number;
  const defaultVal = GRAPH_SETTINGS_DEFAULTS[props.field.key] as number;
  const isChanged = () => value() !== defaultVal;

  return (
    <div class="flex items-center gap-3 px-3 py-2">
      <span
        class="w-36 shrink-0 text-[0.6875rem] text-text-muted"
        classList={{ "text-text-secondary!": isChanged() }}
      >
        {props.field.label}
      </span>
      <input
        type="range"
        min={props.field.min}
        max={props.field.max}
        step={props.field.step}
        value={value()}
        class="h-1 flex-1 cursor-pointer appearance-none rounded-full bg-ghost-hover accent-accent [&::-webkit-slider-thumb]:size-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-accent"
        onInput={(e) => {
          const v = parseFloat(e.currentTarget.value);
          if (!Number.isNaN(v)) {
            updateGraphSetting(props.field.key, v as GraphSettings[keyof GraphSettings]);
          }
        }}
      />
      <span
        class="w-12 text-right font-mono text-[0.625rem] text-text-muted tabular-nums"
        classList={{ "text-accent!": isChanged() }}
      >
        {formatValue(value(), props.field.step)}
      </span>
    </div>
  );
}

function ToggleRow(props: { field: FieldDesc }): JSX.Element {
  const value = () => settings[props.field.key] as boolean;

  return (
    <div class="flex items-center gap-3 px-3 py-2">
      <span class="w-36 shrink-0 text-[0.6875rem] text-text-muted">{props.field.label}</span>
      <div class="flex-1" />
      <Switch
        checked={value()}
        onChange={(v) => {
          updateGraphSetting(props.field.key, v as GraphSettings[keyof GraphSettings]);
        }}
      />
    </div>
  );
}

// ── Exports ──

export {
  getGraphSettings,
  GraphSettingsPanel,
  loadGraphSettings,
  resetGraphSettings,
  restoreGraphSettingsDefaults,
  updateGraphSetting,
};
