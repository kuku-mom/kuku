import { invoke } from "@tauri-apps/api/core";

import { runPluginResets } from "~/plugins/registry";
import { resetDiffStore } from "~/stores/diff_store";
import { resetEditorState } from "~/stores/editor";
import { resetFilesState, type SettingsTarget } from "~/stores/files";
import { resetLayoutState } from "~/stores/layout";
import { resetSettings } from "~/stores/settings";
import { resetTyping } from "~/stores/typing";
import { clearConfiguredVault } from "~/stores/vault";

const DEFAULT_SETTINGS_TARGET: SettingsTarget = {
  kind: "category",
  categoryId: "general",
  anchor: "general",
};

async function resetAllDesktopState(): Promise<void> {
  await clearConfiguredVault();

  localStorage.clear();

  await Promise.all([invoke<void>("plugin_clear_all_settings"), invoke<void>("auth_reset")]);

  resetSettings();
  resetLayoutState();
  resetFilesState({
    preserveSettingsDialog: true,
    settingsTarget: DEFAULT_SETTINGS_TARGET,
  });
  resetEditorState();
  resetDiffStore();
  resetTyping();
  await runPluginResets();
}

export { resetAllDesktopState };
