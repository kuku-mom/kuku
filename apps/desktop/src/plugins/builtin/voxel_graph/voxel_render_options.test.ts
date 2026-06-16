import { describe, expect, it } from "vitest";

import {
  agentSpeedMultiplier,
  natureDensityMultiplier,
  normalizeVoxelRenderSettings,
  VOXEL_RENDER_SETTINGS_DEFAULTS,
} from "./voxel_render_options";

describe("voxel render options", () => {
  it("uses current rendering defaults", () => {
    expect(normalizeVoxelRenderSettings({})).toEqual(VOXEL_RENDER_SETTINGS_DEFAULTS);
  });

  it("accepts only configured agent count options", () => {
    expect(
      normalizeVoxelRenderSettings({
        maxAgents: 300,
        agentSpeed: "high",
        natureDensity: "low",
      }),
    ).toEqual({
      maxAgents: 300,
      agentSpeed: "high",
      natureDensity: "low",
    });
  });

  it("supports rendering every agent", () => {
    expect(normalizeVoxelRenderSettings({ maxAgents: "all" }).maxAgents).toBe("all");
  });

  it("falls back from invalid presets", () => {
    expect(
      normalizeVoxelRenderSettings({
        maxAgents: -12,
        agentSpeed: "fast",
        natureDensity: null,
      }),
    ).toEqual({
      maxAgents: 120,
      agentSpeed: "medium",
      natureDensity: "medium",
    });
  });

  it("keeps medium presets as the existing baseline", () => {
    expect(agentSpeedMultiplier("medium")).toBe(1);
    expect(natureDensityMultiplier("medium")).toBe(1);
  });
});
