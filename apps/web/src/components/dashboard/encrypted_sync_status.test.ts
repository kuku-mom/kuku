import { describe, expect, it } from 'vitest';

import { encryptedSyncMockStatus } from './encrypted_sync_status';

describe('encrypted sync mock status', () => {
  it('uses fixed mock dashboard values without API metadata', () => {
    expect(encryptedSyncMockStatus).toEqual({
      connectedDevices: '2 devices',
      lastSyncActivity: 'Mock data',
      recoveryPhrase: 'Configured',
      serverVaults: '2 encrypted vaults',
      storage: '128 MB encrypted objects',
    });
  });
});
