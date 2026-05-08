import type { SyncRuntimeStatus } from "./types";

type SyncIndicatorKind =
  | "hidden"
  | "idle"
  | "pending"
  | "syncing"
  | "uploading"
  | "downloading"
  | "transferring"
  | "retryingUpload"
  | "retryingDownload"
  | "conflict"
  | "notConfigured"
  | "loginRequired"
  | "permissionRequired"
  | "syncDisabled"
  | "offline"
  | "passphraseFailed"
  | "quotaExceeded"
  | "serverError"
  | "unknownError";

type SyncIndicatorTone = "neutral" | "info" | "warning" | "error" | "success";

interface SyncIndicatorState {
  kind: SyncIndicatorKind;
  visible: boolean;
  tone: SyncIndicatorTone;
  active: boolean;
}

const ACTIVE_PHASES = new Set<SyncRuntimeStatus["phase"]>([
  "planning",
  "packing",
  "transferring",
  "publishing",
  "applying",
]);
const SYNCED_IDLE_DELAY_MS = 2_000;

function hiddenState(): SyncIndicatorState {
  return {
    kind: "hidden",
    visible: false,
    tone: "neutral",
    active: false,
  };
}

function syncIndicatorState(status: SyncRuntimeStatus, nowMs = Date.now()): SyncIndicatorState {
  switch (status.lastErrorCategory) {
    case "notConfigured":
      return { kind: "notConfigured", visible: true, tone: "error", active: false };
    case "loginRequired":
      return { kind: "loginRequired", visible: true, tone: "error", active: false };
    case "permissionRequired":
      return { kind: "permissionRequired", visible: true, tone: "error", active: false };
    case "syncDisabled":
      return { kind: "syncDisabled", visible: true, tone: "error", active: false };
    case "offline":
      return { kind: "offline", visible: true, tone: "error", active: false };
    case "passphraseFailed":
      return { kind: "passphraseFailed", visible: true, tone: "error", active: false };
    case "quotaExceeded":
      return { kind: "quotaExceeded", visible: true, tone: "error", active: false };
    case "server":
      return { kind: "serverError", visible: true, tone: "error", active: false };
    case "unknown":
      return { kind: "unknownError", visible: true, tone: "error", active: false };
    default:
      break;
  }

  if (status.phase === "error") {
    return { kind: "unknownError", visible: true, tone: "error", active: false };
  }

  if (status.conflictCount > 0) {
    return { kind: "conflict", visible: true, tone: "warning", active: false };
  }

  if (status.transfer.active) {
    if (status.transfer.retrying) {
      return status.transfer.direction === "download"
        ? { kind: "retryingDownload", visible: true, tone: "neutral", active: true }
        : { kind: "retryingUpload", visible: true, tone: "neutral", active: true };
    }

    if (status.transfer.direction === "upload") {
      return { kind: "uploading", visible: true, tone: "neutral", active: true };
    }

    if (status.transfer.direction === "download") {
      return { kind: "downloading", visible: true, tone: "neutral", active: true };
    }

    return { kind: "transferring", visible: true, tone: "neutral", active: true };
  }

  if (ACTIVE_PHASES.has(status.phase)) {
    return { kind: "syncing", visible: true, tone: "neutral", active: true };
  }

  if (
    status.configured &&
    status.enabled &&
    (status.pendingUploads > 0 || status.pendingDownloads > 0)
  ) {
    return { kind: "pending", visible: true, tone: "neutral", active: false };
  }

  if (status.configured && status.enabled && status.phase === "idle") {
    if (
      status.lastSyncedAtMs !== undefined &&
      nowMs - status.lastSyncedAtMs < SYNCED_IDLE_DELAY_MS
    ) {
      return { kind: "syncing", visible: true, tone: "neutral", active: true };
    }

    return { kind: "idle", visible: true, tone: "neutral", active: false };
  }

  return hiddenState();
}

export { SYNCED_IDLE_DELAY_MS, syncIndicatorState };
export type { SyncIndicatorKind, SyncIndicatorState, SyncIndicatorTone };
