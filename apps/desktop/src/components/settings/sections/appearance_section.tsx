import { FontInput } from "~/components/settings/font_input";
import {
  SettingsFieldRow,
  SettingsPanel,
  SettingsSelect,
} from "~/components/settings/settings_blocks";
import { t } from "~/i18n";
import { setAppearanceSetting, settingsState } from "~/stores/settings";

function AppearanceSection() {
  const themeOptions = [
    { value: "system", label: t("settings.appearance.theme.system") },
    { value: "dark", label: t("settings.appearance.theme.dark") },
    { value: "light", label: t("settings.appearance.theme.light") },
  ];
  const languageOptions = [
    { value: "system", label: t("settings.appearance.language.system") },
    { value: "en", label: t("settings.appearance.language.en") },
    { value: "ko", label: t("settings.appearance.language.ko") },
    { value: "ja", label: t("settings.appearance.language.ja") },
  ];

  return (
    <SettingsPanel
      title={t("settings.appearance.title")}
      description={t("settings.appearance.description")}
      anchor="appearance"
    >
      <SettingsFieldRow
        label={t("settings.appearance.language.label")}
        description={t("settings.appearance.language.description")}
        control={
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
        }
      />
      <SettingsFieldRow
        label={t("settings.appearance.theme.label")}
        description={t("settings.appearance.theme.description")}
        control={
          <div class="w-full max-w-56">
            <SettingsSelect
              options={themeOptions}
              value={settingsState.appearance.theme}
              onChange={(value) =>
                setAppearanceSetting("theme", value as "system" | "light" | "dark")
              }
              placeholder={t("settings.appearance.theme.placeholder")}
            />
          </div>
        }
      />
      <SettingsFieldRow
        label={t("settings.appearance.ui_font.label")}
        description={t("settings.appearance.ui_font.description")}
        control={
          <div class="w-full max-w-70">
            <FontInput
              value={settingsState.appearance.fontFamily}
              placeholder={t("settings.appearance.ui_font.placeholder")}
              onCommit={(value) => setAppearanceSetting("fontFamily", value)}
            />
          </div>
        }
      />
    </SettingsPanel>
  );
}

export { AppearanceSection };
