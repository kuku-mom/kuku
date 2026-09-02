import { describe, expect, it } from "vitest";

import {
  MeetingDetectionPromptCoordinator,
  readMeetingDetectionPreference,
  type MeetingDetectionSnapshot,
} from "./detection_prompt";

const zoom: MeetingDetectionSnapshot = {
  available: true,
  detected: true,
  appName: "Zoom",
  bundleId: "us.zoom.xos",
  windowId: 42,
};
const cleared: MeetingDetectionSnapshot = {
  available: true,
  detected: false,
  appName: null,
  bundleId: null,
  windowId: null,
};

describe("meeting detection preference", () => {
  it("defaults to enabled and only an explicit false disables it", () => {
    expect(readMeetingDetectionPreference(null)).toBe(true);
    expect(readMeetingDetectionPreference("true")).toBe(true);
    expect(readMeetingDetectionPreference("invalid")).toBe(true);
    expect(readMeetingDetectionPreference("false")).toBe(false);
  });

  it("migrates the previous automatic-start preference", () => {
    expect(readMeetingDetectionPreference(null, "false")).toBe(false);
    expect(readMeetingDetectionPreference(null, "true")).toBe(true);
    expect(readMeetingDetectionPreference("true", "false")).toBe(true);
  });
});

describe("MeetingDetectionPromptCoordinator", () => {
  it("prompts once for a detected meeting and ignores duplicate samples", () => {
    const coordinator = new MeetingDetectionPromptCoordinator();
    expect(coordinator.observe(zoom, { enabled: true, busy: false })).toBe("prompt");
    expect(coordinator.observe(zoom, { enabled: true, busy: false })).toBe("none");
  });

  it("does not consume a detection while prompts are disabled", () => {
    const coordinator = new MeetingDetectionPromptCoordinator();
    expect(coordinator.observe(zoom, { enabled: false, busy: false })).toBe("none");
    expect(coordinator.observe(zoom, { enabled: true, busy: false })).toBe("prompt");
  });

  it("consumes a detection that arrives during a manual recording", () => {
    const coordinator = new MeetingDetectionPromptCoordinator();
    expect(coordinator.observe(zoom, { enabled: true, busy: true })).toBe("none");
    expect(coordinator.observe(zoom, { enabled: true, busy: false })).toBe("none");
  });

  it("rearms only after the detector clears the previous session", () => {
    const coordinator = new MeetingDetectionPromptCoordinator();
    expect(coordinator.observe(zoom, { enabled: true, busy: false })).toBe("prompt");
    expect(coordinator.observe(cleared, { enabled: true, busy: false })).toBe("none");
    expect(coordinator.observe(zoom, { enabled: true, busy: false })).toBe("prompt");
  });

  it("keeps unavailable and empty signals inert", () => {
    const coordinator = new MeetingDetectionPromptCoordinator();
    expect(
      coordinator.observe({ ...cleared, available: false }, { enabled: true, busy: false }),
    ).toBe("none");
  });
});
