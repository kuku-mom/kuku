const MEETING_DETECTION_STORAGE_KEY = "kuku-meeting-detection";
const LEGACY_MEETING_AUTO_START_STORAGE_KEY = "kuku-meeting-auto-start";

interface MeetingDetectionSnapshot {
  available: boolean;
  detected: boolean;
  appName: string | null;
  bundleId: string | null;
  windowId: number | null;
}

interface MeetingCaptureTarget {
  bundleId: string;
  windowId: number | null;
}

interface MeetingDetectionContext {
  enabled: boolean;
  busy: boolean;
}

type MeetingDetectionAction = "prompt" | "none";

function readMeetingDetectionPreference(
  value: string | null,
  legacyValue: string | null = null,
): boolean {
  const stored = value ?? legacyValue;
  return stored !== "false";
}

class MeetingDetectionPromptCoordinator {
  private handledDetection: string | null = null;

  observe(
    snapshot: MeetingDetectionSnapshot,
    context: MeetingDetectionContext,
  ): MeetingDetectionAction {
    if (!snapshot.detected) {
      this.handledDetection = null;
      return "none";
    }
    if (!context.enabled) return "none";

    const detectionKey = `${snapshot.bundleId || snapshot.appName || "meeting"}:${snapshot.windowId ?? "app"}`;
    if (this.handledDetection === detectionKey) return "none";

    // Consume detections seen during a manual recording so stopping the
    // recording cannot immediately show a prompt for the same meeting.
    this.handledDetection = detectionKey;
    return context.busy ? "none" : "prompt";
  }
}

export {
  LEGACY_MEETING_AUTO_START_STORAGE_KEY,
  MEETING_DETECTION_STORAGE_KEY,
  MeetingDetectionPromptCoordinator,
  readMeetingDetectionPreference,
};
export type {
  MeetingCaptureTarget,
  MeetingDetectionAction,
  MeetingDetectionContext,
  MeetingDetectionSnapshot,
};
