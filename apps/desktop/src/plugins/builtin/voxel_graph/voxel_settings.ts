import { createStore, reconcile, unwrap } from "solid-js/store";

import { loadPluginSettings, savePluginSettings } from "~/plugins/settings_store";

import {
  normalizeVoxelRenderSettings,
  VOXEL_RENDER_SETTINGS_DEFAULTS,
  type VoxelRenderSettings,
} from "./voxel_render_options";

const VOXEL_SETTINGS_PLUGIN_ID = "voxel-graph";

const [settings, setSettings] = createStore<VoxelRenderSettings>({
  ...VOXEL_RENDER_SETTINGS_DEFAULTS,
});

function getVoxelRenderSettings(): VoxelRenderSettings {
  return settings;
}

function updateVoxelRenderSetting<K extends keyof VoxelRenderSettings>(
  key: K,
  value: VoxelRenderSettings[K],
): void {
  const next = normalizeVoxelRenderSettings({ ...unwrap(settings), [key]: value });
  setSettings(reconcile(next));
  void persistSettings();
}

function restoreVoxelRenderSettingsDefaults(): void {
  setSettings(reconcile({ ...VOXEL_RENDER_SETTINGS_DEFAULTS }));
  void persistSettings();
}

async function loadVoxelRenderSettings(): Promise<void> {
  try {
    const next = await loadPluginSettings<VoxelRenderSettings>({
      pluginId: VOXEL_SETTINGS_PLUGIN_ID,
      defaults: VOXEL_RENDER_SETTINGS_DEFAULTS,
      normalize: (raw) => normalizeVoxelRenderSettings(raw),
    });
    setSettings(reconcile(next));
    try {
      await savePluginSettings(VOXEL_SETTINGS_PLUGIN_ID, next);
    } catch {
      // Loaded settings remain usable even if normalization persistence fails.
    }
  } catch {
    setSettings(reconcile({ ...VOXEL_RENDER_SETTINGS_DEFAULTS }));
  }
}

async function persistSettings(): Promise<void> {
  try {
    await savePluginSettings(VOXEL_SETTINGS_PLUGIN_ID, unwrap(settings));
  } catch {
    // Settings writes are best-effort; keep the optimistic UI state.
  }
}

export {
  getVoxelRenderSettings,
  loadVoxelRenderSettings,
  restoreVoxelRenderSettingsDefaults,
  updateVoxelRenderSetting,
};
