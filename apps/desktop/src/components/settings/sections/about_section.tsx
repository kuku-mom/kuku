import { SettingsMetricRow, SettingsPanel } from "~/components/settings/settings_blocks";

function AboutSection() {
  return (
    <SettingsPanel
      title="About"
      description="Application build information and licensing."
      anchor="about"
    >
      <div class="space-y-2">
        <SettingsMetricRow label="Version" value="0.0.0-dev" />
        <SettingsMetricRow label="License" value="MIT" />
      </div>
    </SettingsPanel>
  );
}

export { AboutSection };
