import type {
  ChatApprovalMessage,
  ChatSessionState,
  ChatSessionStatus,
  ChatToolMessage,
} from "./types";

type ChatUiTone = "neutral" | "accent" | "warning" | "danger" | "success";

interface ChatStatusMeta {
  label: string;
  description: string;
  tone: ChatUiTone;
}

// Exhaustiveness is enforced by `satisfies Record<ChatSessionStatus, …>` —
// adding a new status to the union forces a matching entry here.
const SESSION_STATUS_META = {
  idle: {
    label: "Idle",
    description: "Ready for a new request.",
    tone: "neutral",
  },
  streaming: {
    label: "Thinking",
    description: "The assistant is working and may still call tools.",
    tone: "accent",
  },
  "awaiting-approval": {
    label: "Waiting for approval",
    description: "Waiting for approval before applying changes.",
    tone: "warning",
  },
  applying: {
    label: "Applying",
    description: "Applying approved changes.",
    tone: "warning",
  },
  error: {
    label: "Error",
    description: "The last request failed.",
    tone: "danger",
  },
} as const satisfies Record<ChatSessionStatus, ChatStatusMeta>;

function truncateSingleLine(value: string | undefined, max = 96): string {
  if (!value) return "";
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function getSessionStatusMeta(session: ChatSessionState | null): ChatStatusMeta {
  if (!session) return SESSION_STATUS_META.idle;
  const meta = SESSION_STATUS_META[session.status];
  if (session.status === "error" && session.error) {
    return { ...meta, description: session.error };
  }
  return meta;
}

function getToolStatusLabel(item: ChatToolMessage): string {
  if (item.error) return "Error";
  if (item.success) return "Done";
  return "Running";
}

function getToolStatusTone(item: ChatToolMessage): ChatUiTone {
  if (item.error) return "danger";
  if (item.success) return "success";
  return "accent";
}

function getToolPreview(item: ChatToolMessage): string {
  if (item.error) {
    return truncateSingleLine(item.error, 100);
  }
  if (item.output) {
    return truncateSingleLine(item.output, 100);
  }
  return truncateSingleLine(JSON.stringify(item.arguments), 100) || "Waiting for result.";
}

const APPROVAL_STATUS_LABEL = {
  pending: "Awaiting approval",
  approved: "Approved",
  rejected: "Rejected",
  applied: "Applied",
  conflict: "Conflict",
  error: "Error",
} as const satisfies Record<ChatApprovalMessage["status"], string>;

const APPROVAL_STATUS_TONE = {
  pending: "warning",
  approved: "accent",
  rejected: "neutral",
  applied: "success",
  conflict: "danger",
  error: "danger",
} as const satisfies Record<ChatApprovalMessage["status"], ChatUiTone>;

function getApprovalStatusLabel(item: ChatApprovalMessage): string {
  return APPROVAL_STATUS_LABEL[item.status];
}

function getApprovalStatusTone(item: ChatApprovalMessage): ChatUiTone {
  return APPROVAL_STATUS_TONE[item.status];
}

function getApprovalSummary(item: ChatApprovalMessage): string {
  if (item.error) {
    return truncateSingleLine(item.error, 120);
  }

  if (item.previewText) {
    return truncateSingleLine(item.previewText, 120);
  }

  const summary =
    typeof item.mutation.summary === "string"
      ? item.mutation.summary
      : JSON.stringify(item.mutation);
  return truncateSingleLine(summary, 120) || getApprovalStatusLabel(item);
}

export type { ChatStatusMeta, ChatUiTone };
export {
  getApprovalStatusLabel,
  getApprovalStatusTone,
  getApprovalSummary,
  getSessionStatusMeta,
  getToolPreview,
  getToolStatusLabel,
  getToolStatusTone,
  truncateSingleLine,
};
