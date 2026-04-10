import { createStore, unwrap } from "solid-js/store";

import { loadPluginSettings, savePluginSettings } from "~/plugins/settings_store";

import type { SearchService } from "./service";
import type { IndexerConfig, IndexerStorageLocation } from "./types";

const INDEXER_SETTINGS_PLUGIN_ID = "core-indexer";

const DEFAULT_INDEXER_CONFIG: IndexerConfig = {
  storageLocation: "app-global",
  incrementalUpdates: true,
  reindexOnVaultOpen: true,
  resolutionPolicy: "closest-folder",
};

const [indexerConfig, setIndexerConfig] = createStore<IndexerConfig>({ ...DEFAULT_INDEXER_CONFIG });

function isStorageLocation(value: unknown): value is IndexerStorageLocation {
  return value === "app-global" || value === "vault-local";
}

function mergeIndexerConfig(raw: unknown): IndexerConfig {
  const record =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};

  return {
    ...DEFAULT_INDEXER_CONFIG,
    ...(isStorageLocation(record.storageLocation)
      ? { storageLocation: record.storageLocation }
      : {}),
    ...(typeof record.incrementalUpdates === "boolean"
      ? { incrementalUpdates: record.incrementalUpdates }
      : {}),
    ...(typeof record.reindexOnVaultOpen === "boolean"
      ? { reindexOnVaultOpen: record.reindexOnVaultOpen }
      : {}),
  } satisfies IndexerConfig;
}

async function hydrateIndexerConfigFromSettings(): Promise<void> {
  try {
    const next = await loadPluginSettings<IndexerConfig>({
      pluginId: INDEXER_SETTINGS_PLUGIN_ID,
      defaults: DEFAULT_INDEXER_CONFIG,
      normalize: (raw) => mergeIndexerConfig(raw),
    });
    setIndexerConfig(next);
  } catch {
    setIndexerConfig({ ...DEFAULT_INDEXER_CONFIG });
  }
}

async function loadIndexerConfig(service: SearchService): Promise<void> {
  await hydrateIndexerConfigFromSettings();
  await service.setConfig(unwrap(indexerConfig));
}

async function resetIndexerConfig(service?: SearchService): Promise<void> {
  setIndexerConfig({ ...DEFAULT_INDEXER_CONFIG });
  if (service) {
    await service.setConfig({ ...DEFAULT_INDEXER_CONFIG });
  }
}

async function updateIndexerConfig<K extends keyof IndexerConfig>(
  service: SearchService,
  key: K,
  value: IndexerConfig[K],
): Promise<void> {
  setIndexerConfig(key, value);
  const next = unwrap(indexerConfig);
  await savePluginSettings(INDEXER_SETTINGS_PLUGIN_ID, next);
  await service.setConfig(next);
}

export {
  DEFAULT_INDEXER_CONFIG,
  hydrateIndexerConfigFromSettings,
  indexerConfig,
  loadIndexerConfig,
  resetIndexerConfig,
  updateIndexerConfig,
};
