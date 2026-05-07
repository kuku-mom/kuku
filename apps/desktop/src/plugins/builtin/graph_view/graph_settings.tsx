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

import { t, type MessageKey } from "~/i18n";
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
  labelKey: MessageKey;
  min: number;
  max: number;
  step: number;
  type: "range" | "toggle";
}

interface SectionDesc {
  titleKey: MessageKey;
  fields: FieldDesc[];
}

const SECTIONS: SectionDesc[] = [
  {
    titleKey: "settings.plugin.graph_view.section.forces",
    fields: [
      {
        key: "chargeStrength",
        labelKey: "settings.plugin.graph_view.field.charge_strength",
        min: -500,
        max: -10,
        step: 10,
        type: "range",
      },
      {
        key: "chargeStrengthOrphan",
        labelKey: "settings.plugin.graph_view.field.charge_strength_orphan",
        min: -300,
        max: -10,
        step: 5,
        type: "range",
      },
      {
        key: "linkDistanceSameFolder",
        labelKey: "settings.plugin.graph_view.field.link_distance_same_folder",
        min: 10,
        max: 300,
        step: 5,
        type: "range",
      },
      {
        key: "linkDistanceCrossFolder",
        labelKey: "settings.plugin.graph_view.field.link_distance_cross_folder",
        min: 50,
        max: 500,
        step: 10,
        type: "range",
      },
      {
        key: "centerStrength",
        labelKey: "settings.plugin.graph_view.field.center_strength",
        min: 0,
        max: 0.5,
        step: 0.005,
        type: "range",
      },
      {
        key: "clusterStrength",
        labelKey: "settings.plugin.graph_view.field.cluster_strength",
        min: 0,
        max: 1,
        step: 0.05,
        type: "range",
      },
      {
        key: "clusterRadiusFactor",
        labelKey: "settings.plugin.graph_view.field.cluster_radius_factor",
        min: 0.1,
        max: 0.8,
        step: 0.05,
        type: "range",
      },
    ],
  },
  {
    titleKey: "settings.plugin.graph_view.section.simulation",
    fields: [
      {
        key: "alphaDecay",
        labelKey: "settings.plugin.graph_view.field.alpha_decay",
        min: 0.001,
        max: 0.1,
        step: 0.001,
        type: "range",
      },
      {
        key: "velocityDecay",
        labelKey: "settings.plugin.graph_view.field.velocity_decay",
        min: 0.05,
        max: 0.8,
        step: 0.05,
        type: "range",
      },
      {
        key: "warmupTicks",
        labelKey: "settings.plugin.graph_view.field.warmup_ticks",
        min: 0,
        max: 300,
        step: 10,
        type: "range",
      },
      {
        key: "cooldownTicks",
        labelKey: "settings.plugin.graph_view.field.cooldown_ticks",
        min: 50,
        max: 1000,
        step: 50,
        type: "range",
      },
    ],
  },
  {
    titleKey: "settings.plugin.graph_view.section.node_sizing",
    fields: [
      {
        key: "nodeMinSize",
        labelKey: "settings.plugin.graph_view.field.node_min_size",
        min: 1,
        max: 10,
        step: 0.5,
        type: "range",
      },
      {
        key: "nodeMaxSize",
        labelKey: "settings.plugin.graph_view.field.node_max_size",
        min: 5,
        max: 30,
        step: 0.5,
        type: "range",
      },
      {
        key: "nodeSizeScale",
        labelKey: "settings.plugin.graph_view.field.node_size_scale",
        min: 0.1,
        max: 3,
        step: 0.1,
        type: "range",
      },
      {
        key: "orphanNodeSize",
        labelKey: "settings.plugin.graph_view.field.orphan_node_size",
        min: 1,
        max: 10,
        step: 0.5,
        type: "range",
      },
    ],
  },
  {
    titleKey: "settings.plugin.graph_view.section.display",
    fields: [
      {
        key: "linkOpacity",
        labelKey: "settings.plugin.graph_view.field.link_opacity",
        min: 0.2,
        max: 1.8,
        step: 0.05,
        type: "range",
      },
      {
        key: "linkWidthScale",
        labelKey: "settings.plugin.graph_view.field.link_width_scale",
        min: 0.4,
        max: 2,
        step: 0.05,
        type: "range",
      },
      {
        key: "hoverFadeOpacity",
        labelKey: "settings.plugin.graph_view.field.hover_fade_opacity",
        min: 0.15,
        max: 0.85,
        step: 0.05,
        type: "range",
      },
    ],
  },
  {
    titleKey: "settings.plugin.graph_view.section.links",
    fields: [
      {
        key: "linkCurvature",
        labelKey: "settings.plugin.graph_view.field.link_curvature",
        min: 0,
        max: 0.5,
        step: 0.01,
        type: "range",
      },
      {
        key: "arrowLength",
        labelKey: "settings.plugin.graph_view.field.arrow_length",
        min: 0,
        max: 10,
        step: 0.5,
        type: "range",
      },
    ],
  },
  {
    titleKey: "settings.plugin.graph_view.section.clusters",
    fields: [
      {
        key: "clusterPadding",
        labelKey: "settings.plugin.graph_view.field.cluster_padding",
        min: 10,
        max: 150,
        step: 5,
        type: "range",
      },
      {
        key: "showClusters",
        labelKey: "settings.plugin.graph_view.field.show_clusters",
        min: 0,
        max: 1,
        step: 1,
        type: "toggle",
      },
    ],
  },
  {
    titleKey: "settings.plugin.graph_view.section.backlinks",
    fields: [
      {
        key: "showBacklinks",
        labelKey: "settings.plugin.graph_view.field.show_backlinks",
        min: 0,
        max: 1,
        step: 1,
        type: "toggle",
      },
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
    <div class="@container space-y-3 p-4">
      {/* Header */}
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <h3 class="text-[0.8125rem] font-medium text-text-primary">
            {t("settings.plugin.graph_view.title")}
          </h3>
          <p class="mt-0.5 text-[0.75rem] text-text-muted">
            {t("settings.plugin.graph_view.description")}
          </p>
        </div>
        <button
          type="button"
          class="shrink-0 rounded-xs border border-border bg-bg-secondary px-2.5 py-1 text-[0.6875rem] whitespace-nowrap text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
          onClick={resetGraphSettings}
        >
          {t("settings.plugin.graph_view.reset_all")}
        </button>
      </div>

      {/* Sections */}
      <For each={SECTIONS}>
        {(section) => (
          <div class="rounded-xs border border-border bg-bg-primary">
            <div class="border-b border-border px-3 py-2">
              <span class="text-[0.6875rem] font-medium tracking-wide text-text-secondary uppercase">
                {t(section.titleKey)}
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
    <div class="flex flex-col gap-2 px-3 py-2 @sm:flex-row @sm:items-center @sm:gap-3">
      <div class="flex items-center justify-between gap-2 @sm:contents">
        <span
          class="text-[0.6875rem] text-text-muted @sm:w-36 @sm:shrink-0"
          classList={{ "text-text-secondary!": isChanged() }}
        >
          {t(props.field.labelKey)}
        </span>
        <span
          class="font-mono text-[0.625rem] text-text-muted tabular-nums @sm:order-last @sm:w-12 @sm:text-right"
          classList={{ "text-accent!": isChanged() }}
        >
          {formatValue(value(), props.field.step)}
        </span>
      </div>
      <input
        type="range"
        min={props.field.min}
        max={props.field.max}
        step={props.field.step}
        value={value()}
        class="h-1 w-full cursor-pointer appearance-none rounded-full bg-ghost-hover accent-accent @sm:w-auto @sm:flex-1 [&::-webkit-slider-thumb]:size-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-accent"
        onInput={(e) => {
          const v = parseFloat(e.currentTarget.value);
          if (!Number.isNaN(v)) {
            updateGraphSetting(props.field.key, v as GraphSettings[keyof GraphSettings]);
          }
        }}
      />
    </div>
  );
}

function ToggleRow(props: { field: FieldDesc }): JSX.Element {
  const value = () => settings[props.field.key] as boolean;

  return (
    <div class="flex items-center gap-3 px-3 py-2">
      <span class="min-w-0 flex-1 text-[0.6875rem] text-text-muted">{t(props.field.labelKey)}</span>
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
