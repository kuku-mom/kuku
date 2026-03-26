import type { ChatSessionState } from "./types";

const RESPONDING_STATUSES = ["streaming", "applying"] as const;

function isRespondingStatus(status: ChatSessionState["status"]): boolean {
  return RESPONDING_STATUSES.includes(status as (typeof RESPONDING_STATUSES)[number]);
}

function hasRespondingSession(sessions: Record<string, ChatSessionState>): boolean {
  return Object.values(sessions).some((session) => isRespondingStatus(session.status));
}

export { hasRespondingSession, isRespondingStatus };
