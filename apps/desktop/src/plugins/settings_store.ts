// ── Plugin Settings Store ──
//
// Reactive settings store for individual plugins.
// Backed by Rust commands (`plugin_get_settings` / `plugin_save_settings`)
// which handle file I/O at ~/.kuku/plugins/{pluginId}/settings.json.
//
// Validation uses JSON Schema via @cfworker/json-schema (~3KB gzip).
// SolidJS `createStore` provides fine-grained reactive access for UI binding.
//
// Design: v1.3 §9.2

import { createStore, reconcile, unwrap } from "solid-js/store";
import { invoke } from "@tauri-apps/api/core";
import { Validator } from "@cfworker/json-schema";

import type { JSONSchema } from "~/plugins/types";

// ── Types ──

interface PluginSettingsHandle<T extends Record<string, unknown>> {
  /** Reactive proxy — read directly in JSX for fine-grained updates. */
  settings: T;
  /** Set a single key. Optimistically updates the UI, then persists to Rust. */
  set<K extends keyof T>(key: K, value: T[K]): Promise<void>;
  /** Reset all settings to defaults. */
  reset(): Promise<void>;
}

// ── Factory ──

/**
 * Create a reactive settings handle for a plugin.
 *
 * Flow:
 *   1. Load raw JSON from Rust (`plugin_get_settings`)
 *   2. Apply any pending migrations
 *   3. Validate against JSON Schema (fall back to defaults on failure)
 *   4. Wrap in a SolidJS store for reactive access
 *   5. On `set()` / `reset()`, optimistically update the store then persist via Rust
 *
 * @param pluginId  — plugin's unique ID (determines file path on Rust side)
 * @param defaults  — default settings object (also defines the TS type)
 * @param schema    — JSON Schema for validation
 * @param version   — current settings version (for migrations)
 * @param migrations — optional version-keyed migration functions
 */
async function createPluginSettings<T extends Record<string, unknown>>(
  pluginId: string,
  defaults: T,
  schema: JSONSchema,
  version: number,
  migrations?: Record<number, (old: Record<string, unknown>) => Partial<T>>,
): Promise<PluginSettingsHandle<T>> {
  // 1. Load from Rust backend
  const raw = await invoke<Record<string, unknown>>("plugin_get_settings", { pluginId });

  // 2. Apply migrations
  const migrated = applyMigrations<T>(raw, version, migrations);

  // 3. Validate against JSON Schema
  const candidate = { ...defaults, ...migrated } as T;
  const validator = new Validator(schema as object);
  const result = validator.validate(candidate);
  const initial = result.valid ? candidate : defaults;

  // 4. Create reactive SolidJS store
  const [settings, setSettings] = createStore<T>(initial);

  // 5. Return the handle
  return {
    settings,

    async set<K extends keyof T>(key: K, value: T[K]): Promise<void> {
      // Optimistic UI update
      // biome-ignore lint: dynamic key access requires any cast
      (setSettings as (k: string, v: unknown) => void)(key as string, value);

      // Persist to Rust
      await invoke("plugin_save_settings", {
        pluginId,
        settings: unwrap(settings),
      });
    },

    async reset(): Promise<void> {
      setSettings(reconcile(defaults));

      await invoke("plugin_save_settings", {
        pluginId,
        settings: defaults,
      });
    },
  };
}

// ── Helpers ──

/**
 * Apply sequential migrations from the stored version to the target version.
 *
 * Migrations are keyed by their TARGET version number. They receive the
 * current data and return a partial object that is merged in.
 *
 * The special `__version` key tracks which version the data was last migrated to.
 */
function applyMigrations<T>(
  raw: Record<string, unknown>,
  targetVersion: number,
  migrations?: Record<number, (old: Record<string, unknown>) => Partial<T>>,
): Record<string, unknown> {
  if (!migrations) return raw;

  const storedVersion = (raw.__version as number) ?? 0;
  if (storedVersion >= targetVersion) return raw;

  let migrated = { ...raw };
  for (let v = storedVersion + 1; v <= targetVersion; v++) {
    const migrator = migrations[v];
    if (migrator) {
      migrated = { ...migrated, ...migrator(migrated) };
    }
  }
  migrated.__version = targetVersion;

  return migrated;
}

// ── Exports ──

export { createPluginSettings };
export type { PluginSettingsHandle };
