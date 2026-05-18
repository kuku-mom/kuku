import type { MessageKey } from "~/i18n";

type ChatPermissionPresetId = "default" | "auto-review" | "full-access";
type ChatPermissionProfile = "workspace-scoped" | "agent-workflow";
type ChatApprovalReviewer = "user" | "auto-reviewer";

interface ChatPermissionPreset {
  id: ChatPermissionPresetId;
  label: MessageKey;
  description: MessageKey;
  permissionProfile: ChatPermissionProfile;
  approvalReviewer: ChatApprovalReviewer;
  requiresConfirmation: boolean;
}

type Translate = (key: MessageKey) => string;

const PERMISSION_PRESETS: ChatPermissionPreset[] = [
  {
    id: "default",
    label: "chat.permission.default.label",
    description: "chat.permission.default.description",
    permissionProfile: "workspace-scoped",
    approvalReviewer: "user",
    requiresConfirmation: false,
  },
  {
    id: "auto-review",
    label: "chat.permission.auto_review.label",
    description: "chat.permission.auto_review.description",
    permissionProfile: "workspace-scoped",
    approvalReviewer: "auto-reviewer",
    requiresConfirmation: false,
  },
  {
    id: "full-access",
    label: "chat.permission.full_access.label",
    description: "chat.permission.full_access.description",
    permissionProfile: "agent-workflow",
    approvalReviewer: "user",
    requiresConfirmation: true,
  },
];

function getPermissionPreset(id: ChatPermissionPresetId): ChatPermissionPreset {
  return PERMISSION_PRESETS.find((preset) => preset.id === id) ?? PERMISSION_PRESETS[0];
}

function getPermissionPresetOptions(translate: Translate): Array<
  Omit<ChatPermissionPreset, "label" | "description"> & {
    label: string;
    description: string;
  }
> {
  return PERMISSION_PRESETS.map((preset) => ({
    ...preset,
    label: translate(preset.label),
    description: translate(preset.description),
  }));
}

export {
  getPermissionPreset,
  getPermissionPresetOptions,
  PERMISSION_PRESETS,
  type ChatPermissionPreset,
  type ChatPermissionPresetId,
};
