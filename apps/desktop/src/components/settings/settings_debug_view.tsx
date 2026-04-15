import { For, Show, createMemo, createSignal, onCleanup, type JSX } from "solid-js";

import {
  SettingsBanner,
  SettingsCard,
  SettingsDropdownMenu,
  SettingsFieldRow,
  SettingsInput,
  SettingsListRow,
  SettingsMetricRow,
  SettingsPanel,
  SettingsProgress,
  SettingsStatusBadge,
  SettingsTextarea,
  SettingsToolbarAction,
} from "./settings_blocks";
import Switch from "~/components/ui/switch";
import { authState } from "~/plugins/builtin/core_auth/auth_service";
import { getSearchService } from "~/plugins/builtin/search/runtime";
import type { IndexerDebugStatus } from "~/plugins/builtin/core_indexer/types";
import { indexerStatus } from "~/plugins/builtin/core_indexer/status_store";
import { registryState } from "~/plugins/registry";
import { filesState, getActiveTab } from "~/stores/files";
import { layoutState } from "~/stores/layout";
import { settingsState } from "~/stores/settings";
import { vaultState } from "~/stores/vault";

function buildModeLabel(): string {
  return import.meta.env.DEV ? "development" : "production";
}

function indexerTone(): "success" | "info" | "error" {
  if (indexerStatus.state === "error") return "error";
  if (indexerStatus.state === "indexing") return "info";
  return "success";
}

function reloadDebugView(): void {
  window.location.reload();
}

function formatDebugTimestamp(ts: number | null): string {
  if (!ts) return "None";
  return new Date(ts).toLocaleString();
}

function SettingsDebugView(): JSX.Element {
  const [indexerDebug, setIndexerDebug] = createSignal<IndexerDebugStatus | null>(null);
  const localStorageKeys = createMemo(() => {
    const keys: string[] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key) {
        keys.push(key);
      }
    }
    return keys.sort();
  });

  const activeTabLabel = () => {
    const tab = getActiveTab();
    if (!tab) return "None";
    return `${tab.fileName} (${tab.type})`;
  };

  const activeRightPanel = () => layoutState.activeRightPanelViewId ?? "None";
  const watcherSkippedLabel = () => {
    const skipped = indexerDebug()?.lastWatcherEventSkipped;
    if (skipped === null || skipped === undefined) {
      return "None";
    }
    return skipped ? "true" : "false";
  };
  const refreshIndexerDebug = async () => {
    const service = getSearchService();
    if (!service) {
      setIndexerDebug(null);
      return;
    }

    try {
      setIndexerDebug(await service.getDebugStatus());
    } catch {
      setIndexerDebug(null);
    }
  };

  void refreshIndexerDebug();
  const debugTimer = window.setInterval(() => {
    void refreshIndexerDebug();
  }, 1000);
  onCleanup(() => {
    window.clearInterval(debugTimer);
  });

  const copyDebugSnapshot = async () => {
    const snapshot = {
      buildMode: buildModeLabel(),
      tabCount: filesState.tabs.length,
      activeTab: activeTabLabel(),
      rightPanel: activeRightPanel(),
      pluginCount: Object.keys(registryState.plugins).length,
      activatedPluginCount: registryState.activated.length,
      auth: {
        authenticated: authState.authenticated,
        user: authState.user?.email ?? null,
      },
      indexer: {
        state: indexerStatus.state,
        indexedDocs: indexerStatus.indexedDocs,
        totalDocs: indexerStatus.totalDocs,
        debug: indexerDebug(),
      },
      vaultRoot: vaultState.rootPath,
      language: settingsState.general.language,
      theme: settingsState.appearance.theme,
      localStorageKeys: localStorageKeys(),
    };
    await navigator.clipboard.writeText(JSON.stringify(snapshot, null, 2));
  };
  return (
    <SettingsPanel
      title="Debug"
      description="Development-only runtime snapshot for settings and plugin state."
      anchor="debug"
      action={
        <SettingsDropdownMenu
          label="Actions"
          groups={[
            {
              label: "Debug",
              items: [
                {
                  label: "Copy snapshot",
                  onSelect: () => void copyDebugSnapshot(),
                },
                {
                  label: "Reload window",
                  onSelect: reloadDebugView,
                },
              ],
            },
          ]}
        />
      }
    >
      <SettingsCard
        title="Runtime"
        description="Current app and plugin state snapshot."
        tone="muted"
      >
        <div class="space-y-1.5">
          <SettingsMetricRow label="Build mode" value={buildModeLabel()} />
          <SettingsMetricRow label="Open tabs" value={String(filesState.tabs.length)} />
          <SettingsMetricRow label="Active tab" value={activeTabLabel()} />
          <SettingsMetricRow label="Right panel" value={activeRightPanel()} />
          <SettingsMetricRow
            label="Plugins"
            value={`${registryState.activated.length} / ${Object.keys(registryState.plugins).length}`}
          />
        </div>
      </SettingsCard>

      <SettingsCard
        title="Session"
        description="Current auth, vault, and indexer state."
        tone="subtle"
      >
        <div class="space-y-3">
          <div class="flex items-center justify-between gap-2">
            <span class="text-[0.75rem] text-text-secondary">Auth session</span>
            <SettingsStatusBadge tone={authState.authenticated ? "success" : "neutral"}>
              {authState.authenticated ? "Signed in" : "Signed out"}
            </SettingsStatusBadge>
          </div>
          <div class="flex items-center justify-between gap-2">
            <span class="text-[0.75rem] text-text-secondary">Indexer</span>
            <SettingsStatusBadge tone={indexerTone()}>{indexerStatus.state}</SettingsStatusBadge>
          </div>
          <SettingsMetricRow label="Vault root" value={vaultState.rootPath ?? "None"} />
          <SettingsMetricRow label="Language" value={settingsState.general.language} />
          <SettingsMetricRow label="Theme" value={settingsState.appearance.theme} />
        </div>
      </SettingsCard>

      <SettingsCard
        title="Indexer Debug"
        description="Backend-only debug snapshot for rebuild reasons, watcher dedupe, and last writer job."
        tone="subtle"
      >
        <div class="space-y-1.5">
          <SettingsMetricRow
            label="Runtime active"
            value={indexerDebug()?.runtimeActive ? "Yes" : "No"}
          />
          <SettingsMetricRow label="DB path" value={indexerDebug()?.dbPath ?? "None"} />
          <SettingsMetricRow
            label="Last job"
            value={
              indexerDebug()?.lastJobKind
                ? `${indexerDebug()?.lastJobKind} (${indexerDebug()?.lastJobSource ?? "unknown"})`
                : "None"
            }
          />
          <SettingsMetricRow label="Last job path" value={indexerDebug()?.lastJobPath ?? "None"} />
          <SettingsMetricRow
            label="Last rebuild reason"
            value={indexerDebug()?.lastRebuildReason ?? "None"}
          />
          <SettingsMetricRow
            label="Queued rebuild reason"
            value={indexerDebug()?.queuedRebuildReason ?? "None"}
          />
          <SettingsMetricRow
            label="Rebuild queue"
            value={
              indexerDebug()
                ? `queued=${indexerDebug()?.rebuildQueued ? "true" : "false"} running=${indexerDebug()?.rebuildRunning ? "true" : "false"} rerun=${indexerDebug()?.rebuildRerun ? "true" : "false"}`
                : "None"
            }
          />
          <SettingsMetricRow
            label="Coalesced rebuilds"
            value={String(indexerDebug()?.coalescedRebuildCount ?? 0)}
          />
          <SettingsMetricRow
            label="Coalesced index jobs"
            value={String(indexerDebug()?.coalescedIndexCount ?? 0)}
          />
          <SettingsMetricRow
            label="Last watcher event"
            value={
              indexerDebug()?.lastWatcherEventKind
                ? `${indexerDebug()?.lastWatcherEventKind} (${indexerDebug()?.lastWatcherEventSource ?? "unknown"})`
                : "None"
            }
          />
          <SettingsMetricRow
            label="Watcher path"
            value={indexerDebug()?.lastWatcherEventPath ?? "None"}
          />
          <SettingsMetricRow label="Watcher skipped" value={watcherSkippedLabel()} />
          <SettingsMetricRow
            label="Watcher timestamp"
            value={formatDebugTimestamp(indexerDebug()?.lastWatcherEventAt ?? null)}
          />
        </div>
      </SettingsCard>

      <SettingsCard
        title="Persistence"
        description="Frontend storage keys visible in the current renderer."
      >
        <div class="space-y-1.5">
          <SettingsMetricRow label="localStorage keys" value={String(localStorageKeys().length)} />
        </div>
        <Show when={localStorageKeys().length > 0}>
          <div class="mt-3 flex flex-wrap gap-2">
            <For each={localStorageKeys()}>
              {(key) => (
                <span class="rounded-xs border border-border bg-bg-secondary px-2 py-1 text-[0.6875rem] text-text-secondary">
                  {key}
                </span>
              )}
            </For>
          </div>
        </Show>
      </SettingsCard>

      <SettingsCard
        title="Field Row"
        description="Preview of the shared field row layout before applying it to real settings."
      >
        <div class="space-y-2">
          <SettingsFieldRow
            label="Compact row"
            description="Inline control aligned to the right for switches and compact inputs."
            control={<Switch checked={settingsState.general.autoSave} onChange={() => {}} />}
          />
          <SettingsFieldRow
            label="Stacked row"
            description="Full-width control layout for larger fields like text inputs or selects."
            stacked
            control={
              <input
                type="text"
                value={vaultState.rootPath ?? ""}
                placeholder="Preview input"
                class="w-full rounded-xs border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary outline-none"
                readOnly
              />
            }
          />
        </div>
      </SettingsCard>

      <SettingsCard
        title="Banner"
        description="Preview of shared feedback banners for info, warning, success, and error states."
      >
        <div class="space-y-2">
          <SettingsBanner
            tone="info"
            title="Info banner"
            description="Use this for neutral runtime or configuration guidance."
          />
          <SettingsBanner
            tone="success"
            title="Success banner"
            description="Use this when an action completed and the user only needs confirmation."
          />
          <SettingsBanner
            tone="warning"
            title="Warning banner"
            description="Use this for operations that deserve attention before continuing."
            action={
              <button
                type="button"
                class="rounded-xs border border-warning-border px-2 py-1 text-[0.6875rem] text-warning"
              >
                Review
              </button>
            }
          />
          <SettingsBanner
            tone="error"
            title="Error banner"
            description="Use this when the current settings state is invalid or a fetch failed."
          />
        </div>
      </SettingsCard>

      <SettingsCard
        title="Toolbar Action"
        description="Preview of shared header action button variants before applying them to real settings."
      >
        <div class="flex flex-wrap gap-2">
          <SettingsToolbarAction>Default</SettingsToolbarAction>
          <SettingsToolbarAction variant="primary">Primary</SettingsToolbarAction>
          <SettingsToolbarAction variant="warning">Warning</SettingsToolbarAction>
          <SettingsToolbarAction variant="destructive">Destructive</SettingsToolbarAction>
          <SettingsToolbarAction disabled>Disabled</SettingsToolbarAction>
        </div>
      </SettingsCard>

      <SettingsCard
        title="List Row"
        description="Preview of shared list rows for plugin access, inventories, and status lists."
      >
        <div class="space-y-2">
          <SettingsListRow
            title="ai-chat"
            description="Allow this plugin to use your Kuku server session."
            meta={<SettingsStatusBadge tone="success">Allowed</SettingsStatusBadge>}
            action={<Switch checked onChange={() => {}} />}
          />
          <SettingsListRow
            title="graph-view"
            description="Uses the current vault graph and indexing state for assistant tools."
            meta={<SettingsStatusBadge tone="info">Requested</SettingsStatusBadge>}
            action={<SettingsToolbarAction>Inspect</SettingsToolbarAction>}
          />
          <SettingsListRow
            title="core-indexer.settings"
            description="Settings section target for index state and rebuild controls."
          />
        </div>
      </SettingsCard>

      <SettingsCard
        title="Progress"
        description="Preview of shared progress blocks for indexing and long-running tasks."
      >
        <div class="space-y-3">
          <SettingsProgress label="Indexer" value={42} max={100} tone="info" />
          <SettingsProgress label="Sync" value={8} max={8} tone="success" />
          <SettingsProgress label="Migration" value={2} max={5} tone="warning" />
        </div>
      </SettingsCard>

      <SettingsCard
        title="Input"
        description="Preview of shared input shells before applying them to real settings."
      >
        <div class="space-y-2">
          <SettingsInput type="text" value="Debug value" placeholder="Text input" readOnly />
          <SettingsInput
            type="url"
            value="http://localhost:8080"
            placeholder="Server URL"
            readOnly
          />
          <SettingsInput type="password" value="debug-secret" placeholder="API key" readOnly />
          <SettingsInput
            type="search"
            value="plugin:ai-chat"
            placeholder="Search settings"
            readOnly
          />
          <SettingsTextarea value={"Line one\nLine two\nLine three"} readOnly />
        </div>
      </SettingsCard>
    </SettingsPanel>
  );
}

export { SettingsDebugView };
