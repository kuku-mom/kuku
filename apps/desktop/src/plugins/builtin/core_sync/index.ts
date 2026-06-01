import { lazy } from "solid-js";

import type { AuthService } from "../core_auth";
import type { KukuPlugin } from "~/plugins/types";

import { createSyncService } from "./service";
import { getSyncService, setSyncService } from "./runtime";
import { refreshSyncStatus, resetSyncStatus, startSyncStatusBridge } from "./status_store";
import { SyncStatusIndicator } from "./sync_status_indicator";

const SyncSettingsView = lazy(() =>
  import("./sync_settings").then((module) => ({ default: module.SyncSettings })),
);

const coreSyncPlugin: KukuPlugin = {
  id: "core-sync",
  name: "Sync",
  version: "0.1.0",
  description: "End-to-end encrypted sync settings and status",
  canDisable: false,
  dependencies: ["core-auth"],

  views: [
    {
      id: "core-sync.settings",
      label: "Sync",
      location: { slot: "settingsSection" },
      order: 20,
      component: SyncSettingsView,
    },
    {
      id: "core-sync.statusIndicator",
      label: "Sync Status",
      location: { slot: "overlay" },
      order: 40,
      component: SyncStatusIndicator,
    },
  ],

  commands: [
    {
      id: "core-sync.syncNow",
      label: "Sync Now",
      category: "Sync",
      execute: () => {
        const service = getSyncService();
        if (!service) return;
        void service
          .runOnce()
          .then(() => refreshSyncStatus(service, { scanLocal: true }))
          .catch(() => refreshSyncStatus(service, { scanLocal: true }));
      },
    },
  ],

  reset() {
    resetSyncStatus();
  },

  activate(ctx) {
    const auth = ctx.services.get("auth") as AuthService | null;
    const service = createSyncService(auth);
    setSyncService(service);
    ctx.services.register("sync", service);
    ctx.track(startSyncStatusBridge(service));
    ctx.track(() => {
      setSyncService(null);
      resetSyncStatus();
    });
  },
};

export { coreSyncPlugin };
export type { SyncService } from "./service";
export type {
  SyncConflictSummary,
  SyncPhase,
  SyncRemoteStatus,
  SyncRuntimeStatus,
  SyncStatusEvent,
  SyncVaultConfig,
} from "./types";
