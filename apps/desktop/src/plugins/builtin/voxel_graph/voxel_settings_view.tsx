import { createMemo, type JSX } from "solid-js";

import {
  SettingsCard,
  SettingsFieldRow,
  SettingsPanel,
  SettingsSelect,
  SettingsToolbarAction,
} from "~/components/settings/settings_blocks";
import { t, type MessageKey } from "~/i18n";

import { AGENT_COUNTS, type VoxelAgentCount, type VoxelRenderPreset } from "./voxel_render_options";
import {
  getVoxelRenderSettings,
  restoreVoxelRenderSettingsDefaults,
  updateVoxelRenderSetting,
} from "./voxel_settings";

const PRESET_OPTIONS: { value: VoxelRenderPreset; labelKey: MessageKey }[] = [
  { value: "low", labelKey: "settings.plugin.voxel_graph.option.low" },
  { value: "medium", labelKey: "settings.plugin.voxel_graph.option.medium" },
  { value: "high", labelKey: "settings.plugin.voxel_graph.option.high" },
];

const AGENT_COUNT_OPTIONS: { value: VoxelAgentCount; labelKey: MessageKey }[] = [
  { value: 0, labelKey: "settings.plugin.voxel_graph.agent_count.none" },
  { value: 60, labelKey: "settings.plugin.voxel_graph.agent_count.60" },
  { value: 120, labelKey: "settings.plugin.voxel_graph.agent_count.120" },
  { value: 300, labelKey: "settings.plugin.voxel_graph.agent_count.300" },
  { value: "all", labelKey: "settings.plugin.voxel_graph.agent_count.all" },
];

function presetOptions(): { value: string; label: string }[] {
  return PRESET_OPTIONS.map((option) => ({
    value: option.value,
    label: t(option.labelKey),
  }));
}

function agentCountOptions(): { value: string; label: string }[] {
  return AGENT_COUNT_OPTIONS.map((option) => ({
    value: String(option.value),
    label: t(option.labelKey),
  }));
}

function parseAgentCount(value: string): VoxelAgentCount {
  if (value === "all") return "all";
  const numeric = Number.parseInt(value, 10);
  return AGENT_COUNTS.includes(numeric as Exclude<VoxelAgentCount, "all">)
    ? (numeric as VoxelAgentCount)
    : 120;
}

function VoxelSettingsView(): JSX.Element {
  const settings = getVoxelRenderSettings();
  const agentOptions = createMemo(agentCountOptions);
  const speedOptions = createMemo(presetOptions);
  const densityOptions = createMemo(presetOptions);

  return (
    <SettingsPanel
      title={t("settings.plugin.voxel_graph.title")}
      description={t("settings.plugin.voxel_graph.description")}
      action={
        <SettingsToolbarAction onClick={restoreVoxelRenderSettingsDefaults}>
          {t("settings.plugin.voxel_graph.reset_all")}
        </SettingsToolbarAction>
      }
    >
      <SettingsCard
        title={t("settings.plugin.voxel_graph.section.population")}
        description={t("settings.plugin.voxel_graph.section.population_description")}
        tone="subtle"
      >
        <div class="space-y-3">
          <SettingsFieldRow
            label={t("settings.plugin.voxel_graph.field.max_agents")}
            description={t("settings.plugin.voxel_graph.field.max_agents_description")}
            control={
              <div class="w-full max-w-52">
                <SettingsSelect
                  options={agentOptions()}
                  value={String(settings.maxAgents)}
                  onChange={(value) =>
                    updateVoxelRenderSetting("maxAgents", parseAgentCount(value))
                  }
                  placeholder={t("settings.plugin.voxel_graph.field.max_agents")}
                  label={t("settings.plugin.voxel_graph.field.max_agents")}
                />
              </div>
            }
          />

          <SettingsFieldRow
            label={t("settings.plugin.voxel_graph.field.agent_speed")}
            description={t("settings.plugin.voxel_graph.field.agent_speed_description")}
            control={
              <div class="w-full max-w-52">
                <SettingsSelect
                  options={speedOptions()}
                  value={settings.agentSpeed}
                  onChange={(value) =>
                    updateVoxelRenderSetting("agentSpeed", value as VoxelRenderPreset)
                  }
                  placeholder={t("settings.plugin.voxel_graph.field.agent_speed")}
                  label={t("settings.plugin.voxel_graph.field.agent_speed")}
                />
              </div>
            }
          />
        </div>
      </SettingsCard>

      <SettingsCard
        title={t("settings.plugin.voxel_graph.section.environment")}
        description={t("settings.plugin.voxel_graph.section.environment_description")}
        tone="subtle"
      >
        <SettingsFieldRow
          label={t("settings.plugin.voxel_graph.field.nature_density")}
          description={t("settings.plugin.voxel_graph.field.nature_density_description")}
          control={
            <div class="w-full max-w-52">
              <SettingsSelect
                options={densityOptions()}
                value={settings.natureDensity}
                onChange={(value) =>
                  updateVoxelRenderSetting("natureDensity", value as VoxelRenderPreset)
                }
                placeholder={t("settings.plugin.voxel_graph.field.nature_density")}
                label={t("settings.plugin.voxel_graph.field.nature_density")}
              />
            </div>
          }
        />
      </SettingsCard>
    </SettingsPanel>
  );
}

export { VoxelSettingsView };
