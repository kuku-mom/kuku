import { getVersion } from "@tauri-apps/api/app";
import { createSignal, onMount } from "solid-js";

import { SettingsMetricRow, SettingsPanel } from "~/components/settings/settings_blocks";

function AboutSection() {
  const [version, setVersion] = createSignal("Loading...");

  onMount(() => {
    void getVersion()
      .then((value) => setVersion(value))
      .catch(() => setVersion("Unknown"));
  });

  return (
    <SettingsPanel
      title="About"
      description="Application build information and licensing."
      anchor="about"
    >
      <div class="space-y-2">
        <SettingsMetricRow label="Version" value={version()} />
        <SettingsMetricRow label="License" value="MIT" />
      </div>
    </SettingsPanel>
  );
}

export { AboutSection };
