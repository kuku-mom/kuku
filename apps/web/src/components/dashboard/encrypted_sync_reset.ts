export const ENCRYPTED_SYNC_RESET_CONFIRMATION_TEXT = 'reset encrypted sync';
export const ENCRYPTED_SYNC_RESET_STUB_MESSAGE =
  'Reset request UI is ready. Server-side reset is not implemented yet.';

export function canRequestEncryptedSyncReset(confirmText: string): boolean {
  return confirmText.trim() === ENCRYPTED_SYNC_RESET_CONFIRMATION_TEXT;
}
