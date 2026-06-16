export type VoxelRenderPreset = "low" | "medium" | "high";
export type VoxelAgentCount = 0 | 60 | 120 | 300 | "all";

export interface VoxelRenderSettings {
  maxAgents: VoxelAgentCount;
  agentSpeed: VoxelRenderPreset;
  natureDensity: VoxelRenderPreset;
}

const PRESETS = new Set<VoxelRenderPreset>(["low", "medium", "high"]);
const AGENT_COUNTS: readonly Exclude<VoxelAgentCount, "all">[] = [0, 60, 120, 300];

export const VOXEL_RENDER_SETTINGS_DEFAULTS: VoxelRenderSettings = {
  maxAgents: 120,
  agentSpeed: "medium",
  natureDensity: "medium",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeAgentCount(value: unknown): VoxelAgentCount {
  if (value === "all") return "all";
  return typeof value === "number" &&
    AGENT_COUNTS.includes(value as Exclude<VoxelAgentCount, "all">)
    ? (value as VoxelAgentCount)
    : VOXEL_RENDER_SETTINGS_DEFAULTS.maxAgents;
}

function normalizePreset(value: unknown, fallback: VoxelRenderPreset): VoxelRenderPreset {
  return typeof value === "string" && PRESETS.has(value as VoxelRenderPreset)
    ? (value as VoxelRenderPreset)
    : fallback;
}

export function normalizeVoxelRenderSettings(raw: unknown): VoxelRenderSettings {
  if (!isRecord(raw)) return { ...VOXEL_RENDER_SETTINGS_DEFAULTS };
  return {
    maxAgents: normalizeAgentCount(raw.maxAgents),
    agentSpeed: normalizePreset(raw.agentSpeed, VOXEL_RENDER_SETTINGS_DEFAULTS.agentSpeed),
    natureDensity: normalizePreset(raw.natureDensity, VOXEL_RENDER_SETTINGS_DEFAULTS.natureDensity),
  };
}

export function agentSpeedMultiplier(preset: VoxelRenderPreset): number {
  switch (preset) {
    case "low":
      return 0.68;
    case "high":
      return 1.35;
    case "medium":
    default:
      return 1;
  }
}

export function natureDensityMultiplier(preset: VoxelRenderPreset): number {
  switch (preset) {
    case "low":
      return 0.55;
    case "high":
      return 1.4;
    case "medium":
    default:
      return 1;
  }
}

export { AGENT_COUNTS };
