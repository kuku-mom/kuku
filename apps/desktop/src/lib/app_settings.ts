import { invoke } from "@tauri-apps/api/core";

interface AppSettings {
  last_opened_vault?: string;
  [key: string]: unknown;
}

async function getAppSettings(): Promise<AppSettings> {
  return invoke<AppSettings>("app_settings_get");
}

async function setAppSettings(settings: AppSettings): Promise<void> {
  await invoke<void>("app_settings_set", { settings });
}

async function getLastOpenedVault(): Promise<string | null> {
  const settings = await getAppSettings();
  return typeof settings.last_opened_vault === "string" && settings.last_opened_vault.length > 0
    ? settings.last_opened_vault
    : null;
}

async function setLastOpenedVault(path: string | null): Promise<void> {
  const settings = await getAppSettings();
  if (path) {
    settings.last_opened_vault = path;
  } else {
    delete settings.last_opened_vault;
  }
  await setAppSettings(settings);
}

export { getAppSettings, getLastOpenedVault, setAppSettings, setLastOpenedVault };
export type { AppSettings };
