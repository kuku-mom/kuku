import type { PMNodeJSON } from "~/lib/markdown";

import type { MeetingTranscriptSegment } from "./meeting_document";

export type MeetingPhase =
  | "idle"
  | "preparing"
  | "downloading"
  | "permission"
  | "recording"
  | "finalizing"
  | "saving"
  | "error";
export interface MeetingState {
  phase: MeetingPhase;
  sessionId: string | null;
  progress: number | null;
  startedAtMs: number | null;
  message: string | null;
  errorCode: string | null;
  microphoneOnly: boolean;
  systemOnly: boolean;
}
export interface Transcript {
  sessionId: string;
  kind: "update" | "final";
  stableText: string;
  unstableText: string;
  speakerId: number | null;
  segments: MeetingTranscriptSegment[];
  speakerLimitWarning: boolean;
}
export interface MeetingResources {
  ready: boolean;
  runtimeReady: boolean;
  transcriptionModelReady: boolean;
  speakerModelReady: boolean;
  estimatedDownloadBytes: number;
  estimatedInstalledBytes: number;
  availableDiskBytes: number | null;
  diskSpaceSufficient: boolean;
}
export interface MeetingTarget {
  vaultRoot: string;
  filePath: string;
  title: string;
}
export interface DocumentCheckpoint {
  content: string;
  expectedChecksum: string;
  doc: PMNodeJSON;
  from: number;
  to: number;
  finalized: boolean;
}
export interface MeetingJournal {
  sessionId: string;
  target: MeetingTarget;
  checkpoint: DocumentCheckpoint;
  transcript: Transcript | null;
}
export type AudioMode = "combined" | "microphone" | "system";

export const IDLE_MEETING: MeetingState = {
  phase: "idle",
  sessionId: null,
  progress: null,
  startedAtMs: null,
  message: null,
  errorCode: null,
  microphoneOnly: false,
  systemOnly: false,
};
