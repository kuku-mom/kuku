import { invoke } from "@tauri-apps/api/core";
import { createStore, unwrap } from "solid-js/store";

import type { SearchService } from "./service";
import type { IndexerConfig, IndexerStorageLocation } from "./types";

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

function mergeIndexerConfig(raw: Record<string, unknown>): IndexerConfig {
  return {
    ...DEFAULT_INDEXER_CONFIG,
    ...(isStorageLocation(raw.storageLocation) ? { storageLocation: raw.storageLocation } : {}),
    ...(typeof raw.incrementalUpdates === "boolean"
      ? { incrementalUpdates: raw.incrementalUpdates }
      : {}),
    ...(typeof raw.reindexOnVaultOpen === "boolean"
      ? { reindexOnVaultOpen: raw.reindexOnVaultOpen }
      : {}),
  } satisfies IndexerConfig;
}

async function hydrateIndexerConfigFromSettings(): Promise<void> {
  try {
    const raw = await invoke<Record<string, unknown>>("plugin_get_settings", {
      pluginId: "core-indexer",
    });
    setIndexerConfig(mergeIndexerConfig(raw));
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
  await invoke("plugin_save_settings", {
    pluginId: "core-indexer",
    settings: next,
  });
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
