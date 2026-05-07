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

interface PluginSettingsDefinition<T extends object> {
  pluginId: string;
  defaults: T;
  secureKeys?: string[];
  schema?: JSONSchema;
  version?: number;
  migrations?: Record<number, (old: Record<string, unknown>) => Partial<T>>;
  normalize?: (raw: Record<string, unknown>, defaults: T) => T;
}

interface PluginSettingsHandle<T extends object> {
  /** Reactive proxy — read directly in JSX for fine-grained updates. */
  settings: T;
  /** Set a single key. Optimistically updates the UI, then persists to Rust. */
  set<K extends keyof T>(key: K, value: T[K]): Promise<void>;
  /** Reset all settings to defaults. */
  reset(): Promise<void>;
  /** Reload from Rust and reconcile the reactive store. */
  reload(): Promise<T>;
  /** Replace the entire settings object and persist it. */
  replace(next: T): Promise<void>;
}

// ── Factory ──

/**
 * Create a reactive settings handle for a plugin.
 *
 * Flow:
 *   1. Load raw JSON from Rust (`plugin_get_settings` or secure variant)
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
async function createPluginSettings<T extends object>(
  definition: PluginSettingsDefinition<T>,
): Promise<PluginSettingsHandle<T>> {
  const initial = await loadPluginSettings(definition);

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
      await savePluginSettings(definition.pluginId, unwrap(settings), definition.secureKeys);
    },

    async reset(): Promise<void> {
      setSettings(reconcile(definition.defaults));

      await savePluginSettings(definition.pluginId, definition.defaults, definition.secureKeys);
    },

    async reload(): Promise<T> {
      const next = await loadPluginSettings(definition);
      setSettings(reconcile(next));
      return next;
    },

    async replace(next: T): Promise<void> {
      setSettings(reconcile(next));
      await savePluginSettings(definition.pluginId, next, definition.secureKeys);
    },
  };
}

async function loadPluginSettings<T extends object>(
  definition: PluginSettingsDefinition<T>,
): Promise<T> {
  const raw = definition.secureKeys?.length
    ? await invoke<Record<string, unknown>>("plugin_get_settings_with_secrets", {
        pluginId: definition.pluginId,
        secureKeys: definition.secureKeys,
      })
    : await invoke<Record<string, unknown>>("plugin_get_settings", {
        pluginId: definition.pluginId,
      });
  return resolvePluginSettings(definition, raw);
}

async function savePluginSettings(
  pluginId: string,
  settings: object,
  secureKeys?: string[],
): Promise<void> {
  if (secureKeys?.length) {
    await invoke("plugin_save_settings_with_secrets", {
      pluginId,
      settings,
      secureKeys,
    });
    return;
  }

  await invoke("plugin_save_settings", {
    pluginId,
    settings,
  });
}

// ── Helpers ──

function resolvePluginSettings<T extends object>(
  definition: PluginSettingsDefinition<T>,
  raw: unknown,
): T {
  const objectRaw = isRecord(raw) ? raw : {};
  const migrated = applyMigrations<T>(objectRaw, definition.version ?? 0, definition.migrations);

  if (definition.normalize) {
    return definition.normalize(migrated, definition.defaults);
  }

  const candidate = { ...definition.defaults, ...migrated } as T;
  if (!definition.schema) return candidate;

  const validator = new Validator(definition.schema as object);
  const result = validator.validate(candidate);
  return result.valid ? candidate : definition.defaults;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
  if (!migrations || targetVersion <= 0) return raw;

  const versionKey = "__version";
  const storedVersion = (raw[versionKey] as number) ?? 0;
  if (storedVersion >= targetVersion) return raw;

  let migrated = { ...raw };
  for (let v = storedVersion + 1; v <= targetVersion; v++) {
    const migrator = migrations[v];
    if (migrator) {
      migrated = { ...migrated, ...migrator(migrated) };
    }
  }
  migrated[versionKey] = targetVersion;

  return migrated;
}

// ── Exports ──

export { createPluginSettings };
export { loadPluginSettings, savePluginSettings };
export type { PluginSettingsDefinition, PluginSettingsHandle };
