export const DELETE_ACCOUNT_CONFIRMATION_TEXT = "delete my account";

export function canRequestAccountDelete(confirmText: string): boolean {
  return confirmText.trim() === DELETE_ACCOUNT_CONFIRMATION_TEXT;
}

export function accountDeleteClickAction(
  confirmText: string,
  confirming: boolean,
): "arm" | "blocked" | "delete" {
  if (!canRequestAccountDelete(confirmText)) return "blocked";
  return confirming ? "delete" : "arm";
}

export function accountDeleteButtonLabel(confirming: boolean): string {
  return confirming ? "Click again to permanently delete" : "Delete account";
}
