import type { SyncService } from "./service";

let syncServiceRef: SyncService | null = null;

function getSyncService(): SyncService | null {
  return syncServiceRef;
}

function setSyncService(service: SyncService | null): void {
  syncServiceRef = service;
}

export { getSyncService, setSyncService };
