import { createSignal } from "solid-js";

import { chooseVaultDirectory } from "~/lib/vault_fs";
import {
  SettingsFieldRow,
  SettingsPanel,
  SettingsStatusBadge,
  SettingsToolbarAction,
} from "~/components/settings/settings_blocks";
import { Select } from "~/components/ui";
import { setGeneralSetting, settingsState } from "~/stores/settings";
import { clearConfiguredVault, openVault } from "~/stores/vault";

const LANGUAGE_OPTIONS = [
  { value: "en", label: "English" },
  { value: "ko", label: "한국어" },
  { value: "ja", label: "日本語" },
];

function VaultFolderControl() {
  const [isBusy, setIsBusy] = createSignal(false);
  const configuredPath = () => settingsState.lastOpenedVault;
  const hasConfiguredPath = () => Boolean(configuredPath());

  const browseForVault = async () => {
    if (isBusy()) return;

    setIsBusy(true);
    try {
      const selected = await chooseVaultDirectory();
      if (!selected) return;
      await openVault(selected);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error("[Settings] Failed to open selected vault", error);
    } finally {
      setIsBusy(false);
    }
  };

  const clearVaultFolder = async () => {
    if (isBusy() || !configuredPath()) return;

    setIsBusy(true);
    try {
      await clearConfiguredVault();
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error("[Settings] Failed to clear configured vault", error);
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <div class="flex flex-col gap-2">
      <div class="flex items-start justify-between gap-3 rounded-xs border border-border/60 bg-bg-primary/60 px-3 py-2">
        <div class="min-w-0 flex-1">
          <div class="text-[0.6875rem] tracking-[0.12em] text-text-muted uppercase">
            Current path
          </div>
          <p class="mt-1 font-mono text-[0.75rem]/5 break-all text-text-secondary">
            {configuredPath() ?? "Not configured"}
          </p>
        </div>
        <SettingsStatusBadge tone={hasConfiguredPath() ? "success" : "neutral"}>
          {hasConfiguredPath() ? "Configured" : "Missing"}
        </SettingsStatusBadge>
      </div>

      <div class="flex flex-wrap gap-2">
        <SettingsToolbarAction disabled={isBusy()} onClick={() => void browseForVault()}>
          {isBusy() ? "Working..." : "Browse..."}
        </SettingsToolbarAction>
        <SettingsToolbarAction
          disabled={isBusy() || !configuredPath()}
          onClick={() => void clearVaultFolder()}
        >
          Clear
        </SettingsToolbarAction>
      </div>
    </div>
  );
}

function GeneralSection() {
  return (
    <SettingsPanel
      title="General"
      description="Configure the active vault and application language."
      anchor="general"
    >
      <SettingsFieldRow
        stacked
        label="Vault folder"
        description="Choose the folder used as the current vault. Changes apply immediately."
        control={<VaultFolderControl />}
      />
      <SettingsFieldRow
        label="Language (WIP)"
        description="Select the display language for the interface."
        control={
          <div class="w-56">
            <Select
              options={LANGUAGE_OPTIONS}
              value={settingsState.general.language}
              onChange={(value) => setGeneralSetting("language", value)}
              placeholder="Select language"
            />
          </div>
        }
      />
    </SettingsPanel>
  );
}

export { GeneralSection };
