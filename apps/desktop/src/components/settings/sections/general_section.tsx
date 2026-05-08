import { createSignal } from "solid-js";

import {
  SettingsFieldRow,
  SettingsPanel,
  SettingsStatusBadge,
  SettingsToolbarAction,
  SettingsCard,
  SettingsSelect,
} from "~/components/settings/settings_blocks";
import { t } from "~/i18n";
import { setAppearanceSetting, settingsState } from "~/stores/settings";
import { clearConfiguredVault, selectVault } from "~/stores/vault";

function VaultFolderControl() {
  const [isBusy, setIsBusy] = createSignal(false);
  const configuredPath = () => settingsState.lastOpenedVault;
  const hasConfiguredPath = () => Boolean(configuredPath());

  const browseForVault = async () => {
    if (isBusy()) return;

    setIsBusy(true);
    try {
      await selectVault();
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
      <SettingsCard
        tone="subtle"
        title={t("settings.general.current_path.title")}
        titleClass="text-[0.6875rem]"
        action={
          <SettingsStatusBadge tone={hasConfiguredPath() ? "success" : "neutral"}>
            {hasConfiguredPath()
              ? t("settings.general.status.configured")
              : t("settings.general.status.missing")}
          </SettingsStatusBadge>
        }
      >
        <p class="font-mono text-[0.75rem]/5 break-all text-text-secondary">
          {configuredPath() ?? t("settings.general.path.not_configured")}
        </p>
      </SettingsCard>

      <div class="flex flex-wrap gap-2">
        <SettingsToolbarAction disabled={isBusy()} onClick={() => void browseForVault()}>
          {isBusy() ? t("settings.general.action.working") : t("settings.general.action.browse")}
        </SettingsToolbarAction>
        <SettingsToolbarAction
          disabled={isBusy() || !configuredPath()}
          onClick={() => void clearVaultFolder()}
        >
          {t("settings.general.action.clear")}
        </SettingsToolbarAction>
      </div>
    </div>
  );
}

function LanguageControl() {
  const languageOptions = [
    { value: "system", label: t("settings.appearance.language.system") },
    { value: "en", label: t("settings.appearance.language.en") },
    { value: "ko", label: t("settings.appearance.language.ko") },
    { value: "ja", label: t("settings.appearance.language.ja") },
  ];

  return (
    <div class="w-full max-w-56">
      <SettingsSelect
        options={languageOptions}
        value={settingsState.appearance.language}
        onChange={(value) =>
          setAppearanceSetting("language", value as "system" | "en" | "ko" | "ja")
        }
        placeholder={t("settings.appearance.language.placeholder")}
      />
    </div>
  );
}

function GeneralSection() {
  return (
    <SettingsPanel
      title={t("settings.general.title")}
      description={t("settings.general.description")}
      anchor="general"
    >
      <SettingsFieldRow
        label={t("settings.appearance.language.label")}
        description={t("settings.appearance.language.description")}
        control={<LanguageControl />}
      />
      <SettingsFieldRow
        stacked
        label={t("settings.general.vault_folder.label")}
        description={t("settings.general.vault_folder.description")}
        control={<VaultFolderControl />}
      />
    </SettingsPanel>
  );
}

export { GeneralSection };
