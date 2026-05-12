import { describe, expect, it } from 'vitest';

import {
  ENCRYPTED_SYNC_RESET_CONFIRMATION_TEXT,
  ENCRYPTED_SYNC_RESET_STUB_MESSAGE,
  canRequestEncryptedSyncReset,
} from './encrypted_sync_reset';

describe('encrypted sync reset confirmation', () => {
  it('requires the exact reset phrase before enabling the stub action', () => {
    expect(canRequestEncryptedSyncReset(ENCRYPTED_SYNC_RESET_CONFIRMATION_TEXT)).toBe(true);
    expect(canRequestEncryptedSyncReset(' reset encrypted sync ')).toBe(true);
    expect(canRequestEncryptedSyncReset('RESET ENCRYPTED SYNC')).toBe(false);
    expect(canRequestEncryptedSyncReset('reset sync')).toBe(false);
  });

  it('exposes the non-functional server-side reset message', () => {
    expect(ENCRYPTED_SYNC_RESET_STUB_MESSAGE).toBe(
      'Reset request UI is ready. Server-side reset is not implemented yet.',
    );
  });
});
