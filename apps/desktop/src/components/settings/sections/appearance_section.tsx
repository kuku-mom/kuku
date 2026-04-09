import { FontInput } from "~/components/settings/font_input";
import { SettingsFieldRow, SettingsPanel } from "~/components/settings/settings_blocks";
import { Select } from "~/components/ui";
import { setAppearanceSetting, settingsState } from "~/stores/settings";

const THEME_OPTIONS = [
  { value: "system", label: "System" },
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
];

function AppearanceSection() {
  return (
    <SettingsPanel
      title="Appearance"
      description="Choose the application theme and interface typography."
      anchor="appearance"
    >
      <SettingsFieldRow
        label="Theme"
        description="Choose between system, dark, and light appearance."
        control={
          <div class="w-56">
            <Select
              options={THEME_OPTIONS}
              value={settingsState.appearance.theme}
              onChange={(value) =>
                setAppearanceSetting("theme", value as "system" | "light" | "dark")
              }
              placeholder="Select theme"
            />
          </div>
        }
      />
      <SettingsFieldRow
        label="UI font"
        description="Font used for the interface. Enter a CSS font-family name."
        control={
          <div class="w-70">
            <FontInput
              value={settingsState.appearance.fontFamily}
              placeholder="e.g. Goorm Sans"
              onCommit={(value) => setAppearanceSetting("fontFamily", value)}
            />
          </div>
        }
      />
    </SettingsPanel>
  );
}

export { AppearanceSection };
