import { createEffect, createSignal, on, onCleanup, Show, type JSX } from "solid-js";

import {
  SettingsBanner,
  SettingsCard,
  SettingsFieldRow,
  SettingsMetricRow,
  SettingsPanel,
  SettingsProgress,
  SettingsStatusBadge,
  SettingsToolbarAction,
} from "~/components/settings/settings_blocks";
import { Select } from "~/components/ui";
import Switch from "~/components/ui/switch";
import { useSettingsRefreshToken } from "~/components/settings/settings_refresh";

import { hydrateIndexerConfigFromSettings, indexerConfig, updateIndexerConfig } from "./settings";
import type { IndexerConfig } from "./types";
import { indexerStatus, refreshIndexerStatus } from "../core_indexer/status_store";
import { getSearchService } from "../search/runtime";

const STORAGE_LOCATION_OPTIONS = [
  { value: "app-global", label: "App data (~/.kuku/search)" },
  { value: "vault-local", label: "Vault local (.kuku/search.sqlite3)" },
] satisfies { value: IndexerConfig["storageLocation"]; label: string }[];

function formatTimestamp(ts: number | null): string {
  if (!ts) return "Never";
  const date = new Date(ts);
  return date.toLocaleString();
}

function statusLabel(state: string): string {
  if (state === "indexing") return "Indexing…";
  if (state === "error") return "Error";
  return "Ready";
}

function statusTone(state: string): "success" | "info" | "error" {
  if (state === "error") return "error";
  if (state === "indexing") return "info";
  return "success";
}

function IndexerSettings(): JSX.Element {
  const [isRefreshingStatus, setIsRefreshingStatus] = createSignal(false);
  const [isRebuildStarting, setIsRebuildStarting] = createSignal(false);
  const isIndexing = () => indexerStatus.state === "indexing";
  const settingsRefreshToken = useSettingsRefreshToken();
  let pollTimer: number | undefined;
  let rebuildBaselineLastIndexedAt: number | null = null;
  let rebuildIssuedAt: number | null = null;

  function clearPolling(): void {
    if (pollTimer !== undefined) {
      window.clearInterval(pollTimer);
      pollTimer = undefined;
    }
  }

  function maybeResolveRebuildStart(): void {
    if (!isRebuildStarting()) return;

    if (indexerStatus.state === "indexing" || indexerStatus.state === "error") {
      setIsRebuildStarting(false);
      rebuildBaselineLastIndexedAt = null;
      rebuildIssuedAt = null;
      return;
    }

    if (
      rebuildBaselineLastIndexedAt !== null &&
      indexerStatus.lastIndexedAt !== null &&
      indexerStatus.lastIndexedAt !== rebuildBaselineLastIndexedAt
    ) {
      setIsRebuildStarting(false);
      rebuildBaselineLastIndexedAt = null;
      rebuildIssuedAt = null;
      return;
    }

    if (rebuildIssuedAt !== null && Date.now() - rebuildIssuedAt > 5000) {
      setIsRebuildStarting(false);
      rebuildBaselineLastIndexedAt = null;
      rebuildIssuedAt = null;
    }
  }

  async function syncIndexerStatus(options?: {
    reloadConfig?: boolean;
    allowWhileRefreshing?: boolean;
  }): Promise<void> {
    if (isRefreshingStatus() && !options?.allowWhileRefreshing) {
      return;
    }

    const service = getSearchService();
    if (!service) return;

    setIsRefreshingStatus(true);
    try {
      if (options?.reloadConfig) {
        await hydrateIndexerConfigFromSettings();
      }
      await refreshIndexerStatus(service);
      maybeResolveRebuildStart();
    } finally {
      setIsRefreshingStatus(false);
    }
  }

  createEffect(
    on(
      settingsRefreshToken,
      () => {
        clearPolling();
        void syncIndexerStatus({ reloadConfig: true, allowWhileRefreshing: true });
        pollTimer = window.setInterval(() => {
          void syncIndexerStatus();
        }, 500);
      },
      { defer: false },
    ),
  );

  onCleanup(() => {
    clearPolling();
  });

  async function handleRebuild(): Promise<void> {
    const service = getSearchService();
    if (!service || isRebuildStarting() || isIndexing()) return;

    rebuildBaselineLastIndexedAt = indexerStatus.lastIndexedAt;
    rebuildIssuedAt = Date.now();
    setIsRebuildStarting(true);

    await service.requestRebuild();
    await syncIndexerStatus({ allowWhileRefreshing: true });
  }

  async function handleRefreshStatus(): Promise<void> {
    await syncIndexerStatus({ allowWhileRefreshing: true });
  }

  async function handleConfigChange<K extends keyof IndexerConfig>(
    key: K,
    value: IndexerConfig[K],
  ): Promise<void> {
    const service = getSearchService();
    if (!service) return;
    await updateIndexerConfig(service, key, value);
    await refreshIndexerStatus(service);
  }

  return (
    <SettingsPanel
      title="Indexer"
      description="Manage search, wikilink graph indexing, and refresh policy."
      action={
        <SettingsToolbarAction
          disabled={isRefreshingStatus() || isRebuildStarting()}
          onClick={() => void handleRefreshStatus()}
        >
          {isRefreshingStatus() ? "Refreshing..." : "Refresh"}
        </SettingsToolbarAction>
      }
    >
      <SettingsCard
        title="Index Status"
        tone="subtle"
        action={
          <SettingsStatusBadge tone={statusTone(indexerStatus.state)}>
            {statusLabel(indexerStatus.state)}
          </SettingsStatusBadge>
        }
      >
        <div class="space-y-1.5">
          <SettingsMetricRow
            label="Documents"
            value={`${indexerStatus.indexedDocs} / ${indexerStatus.totalDocs}`}
          />
          <SettingsMetricRow label="Resolved links" value={String(indexerStatus.resolvedLinks)} />
          <SettingsMetricRow
            label="Unresolved links"
            value={String(indexerStatus.unresolvedLinks)}
          />
          <SettingsMetricRow label="Ambiguous links" value={String(indexerStatus.ambiguousLinks)} />
          <SettingsMetricRow
            label="Last indexed"
            value={formatTimestamp(indexerStatus.lastIndexedAt)}
          />
        </div>

        <Show when={isIndexing() && indexerStatus.totalDocs > 0}>
          <SettingsProgress
            class="mt-3"
            tone="info"
            label="Index progress"
            value={indexerStatus.indexedDocs}
            max={indexerStatus.totalDocs}
          />
        </Show>
      </SettingsCard>

      <Show when={indexerStatus.error}>
        {(error) => <SettingsBanner tone="error" description={error()} />}
      </Show>

      <SettingsCard
        title="Wikilink Indexing"
        description="Resolution policy is fixed to closest-folder."
        tone="subtle"
      >
        <div class="space-y-3">
          <SettingsFieldRow
            label="Index storage location"
            description="Choose whether the SQLite index lives in app data or inside the current vault. Changing this switches to a different DB and queues a rebuild."
            control={
              <div class="w-64">
                <Select
                  options={STORAGE_LOCATION_OPTIONS}
                  value={indexerConfig.storageLocation}
                  onChange={(value) =>
                    void handleConfigChange(
                      "storageLocation",
                      value as IndexerConfig["storageLocation"],
                    )
                  }
                  placeholder="Select location"
                  label="Index storage location"
                />
              </div>
            }
          />
          <SettingsFieldRow
            label="Incremental updates"
            description="Apply file changes as targeted link/index updates instead of full rebuilds."
            control={
              <Switch
                checked={indexerConfig.incrementalUpdates}
                onChange={(checked) => void handleConfigChange("incrementalUpdates", checked)}
              />
            }
          />
          <SettingsFieldRow
            label="Reindex on vault open"
            description="Run a cold-start rebuild when a vault opens."
            control={
              <Switch
                checked={indexerConfig.reindexOnVaultOpen}
                onChange={(checked) => void handleConfigChange("reindexOnVaultOpen", checked)}
              />
            }
          />
        </div>
      </SettingsCard>

      <SettingsCard
        tone="muted"
        description="Rebuild clears and re-indexes search chunks plus wikilink graph data."
        action={
          <SettingsToolbarAction
            variant="warning"
            disabled={isIndexing() || isRebuildStarting()}
            onClick={() => void handleRebuild()}
          >
            {isIndexing() || isRebuildStarting() ? "Indexing…" : "Rebuild Index"}
          </SettingsToolbarAction>
        }
      >
        <div class="text-[0.6875rem] text-text-muted">
          Use rebuild when search results or wikilink graph data need a clean resync.
        </div>
      </SettingsCard>
    </SettingsPanel>
  );
}

export { IndexerSettings };
