import { invoke } from "@tauri-apps/api/core";

import type { InstalledPluginInfo, ThirdPartyPluginManifest } from "./types";

async function installPluginFromDirectory(path: string): Promise<InstalledPluginInfo> {
  return invoke<InstalledPluginInfo>("plugin_install_from_directory", { path });
}

async function installBundledPlugin(pluginId: string): Promise<InstalledPluginInfo> {
  return invoke<InstalledPluginInfo>("plugin_install_bundled", { pluginId });
}

async function listInstalledThirdPartyPlugins(): Promise<InstalledPluginInfo[]> {
  return invoke<InstalledPluginInfo[]>("plugin_list_installed");
}

async function readThirdPartyManifest(path: string): Promise<ThirdPartyPluginManifest> {
  return invoke<ThirdPartyPluginManifest>("plugin_read_manifest", { path });
}

async function uninstallThirdPartyPlugin(pluginId: string, keepData = true): Promise<void> {
  await invoke<void>("plugin_uninstall", { pluginId, keepData });
}

async function callPluginSidecar(
  pluginId: string,
  sidecar: string,
  operation: string,
  params: Record<string, unknown>,
): Promise<string> {
  return invoke<string>("plugin_sidecar_call", { pluginId, sidecar, operation, params });
}

export {
  callPluginSidecar,
  installBundledPlugin,
  installPluginFromDirectory,
  listInstalledThirdPartyPlugins,
  readThirdPartyManifest,
  uninstallThirdPartyPlugin,
};
export type { InstalledPluginInfo, ThirdPartyPluginManifest };
