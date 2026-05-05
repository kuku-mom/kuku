import { createSignal, For, Show, type JSX } from "solid-js";

import {
  SettingsBanner,
  SettingsCard,
  SettingsInput,
  SettingsMetricRow,
  SettingsPanel,
  SettingsStatusBadge,
  SettingsTextarea,
  SettingsToolbarAction,
} from "~/components/settings/settings_blocks";
import { vaultState } from "~/stores/vault";

import { callPluginSidecar } from "./installer";
import type { InstalledPluginInfo, ThirdPartyPluginManifest } from "./types";

function permissionLabels(manifest: ThirdPartyPluginManifest): string[] {
  const permissions = manifest.permissions ?? {};
  const labels: string[] = [];
  if (permissions.sidecar) labels.push("Sidecar");
  if (permissions.vaultRead) labels.push("Vault read");
  if (permissions.vaultWrite) labels.push("Vault write");
  if (permissions.network) labels.push("Network");
  return labels;
}

function GenericThirdPartySettings(props: { info: InstalledPluginInfo }): JSX.Element {
  const manifest = () => props.info.manifest;
  const [busy, setBusy] = createSignal<string | null>(null);
  const [result, setResult] = createSignal<string | null>(null);
  const [settingsError, setSettingsError] = createSignal<string | null>(null);
  const [query, setQuery] = createSignal("");
  const [slug, setSlug] = createSignal("");
  const [pageContent, setPageContent] = createSignal("");

  async function run(sidecar: string, operation: string, params: Record<string, unknown> = {}) {
    if (busy()) return;
    setBusy(operation);
    setResult(null);
    setSettingsError(null);
    try {
      const output = await callPluginSidecar(manifest().id, sidecar, operation, params);
      setResult(output || "Done");
    } catch (error) {
      setSettingsError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }

  function parsedResult(): string {
    const output = result();
    if (!output) return "";
    try {
      return JSON.stringify(JSON.parse(output), null, 2);
    } catch {
      return output;
    }
  }

  const isGbrain = () => manifest().id === "gbrain";
  const hasGbrainSidecar = () => Boolean(manifest().sidecars?.gbrain);
  const packageLabel = () => (isGbrain() ? "Included with Kuku" : "Installed");

  return (
    <SettingsPanel
      title={manifest().name}
      description={manifest().description}
      anchor={`plugin:${manifest().id}`}
    >
      <div class="space-y-3">
        <SettingsCard title="Package" tone="subtle">
          <div class="space-y-2">
            <SettingsMetricRow label="Version" value={manifest().version} />
            <SettingsMetricRow label="Author" value={manifest().author} />
            <SettingsMetricRow label="Package" value={packageLabel()} />
          </div>
        </SettingsCard>

        <SettingsCard title="Permissions" tone="subtle">
          <div class="flex flex-wrap gap-1.5">
            <Show
              when={permissionLabels(manifest()).length > 0}
              fallback={<span class="text-[0.75rem] text-text-muted">No elevated permissions</span>}
            >
              <For each={permissionLabels(manifest())}>
                {(label) => (
                  <SettingsStatusBadge tone="info" class="text-[0.625rem]">
                    {label}
                  </SettingsStatusBadge>
                )}
              </For>
            </Show>
          </div>
        </SettingsCard>

        <Show when={isGbrain() && hasGbrainSidecar()}>
          <SettingsCard
            title="Setup"
            description="Run setup and health checks through the included sidecar."
            tone="subtle"
          >
            <div class="flex flex-wrap gap-2">
              <SettingsToolbarAction
                disabled={busy() !== null}
                onClick={() => void run("gbrain", "version")}
              >
                Version
              </SettingsToolbarAction>
              <SettingsToolbarAction
                disabled={busy() !== null}
                onClick={() => void run("gbrain", "init")}
              >
                Init
              </SettingsToolbarAction>
              <SettingsToolbarAction
                disabled={busy() !== null || !vaultState.rootPath}
                onClick={() => void run("gbrain", "importVault", { path: vaultState.rootPath })}
              >
                Import Vault
              </SettingsToolbarAction>
              <SettingsToolbarAction
                disabled={busy() !== null}
                onClick={() => void run("gbrain", "doctor")}
              >
                Doctor
              </SettingsToolbarAction>
            </div>
          </SettingsCard>
        </Show>

        <Show when={isGbrain() && hasGbrainSidecar()}>
          <SettingsCard
            title="Workbench"
            description="Search and inspect the local brain directly from Kuku."
            tone="subtle"
          >
            <div class="space-y-3">
              <div class="grid gap-2 @md:grid-cols-[minmax(0,1fr)_auto]">
                <SettingsInput
                  value={query()}
                  placeholder="Search or ask GBrain..."
                  onInput={(event) => setQuery(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && query().trim()) {
                      void run("gbrain", "query", { query: query().trim() });
                    }
                  }}
                />
                <div class="flex gap-2">
                  <SettingsToolbarAction
                    disabled={busy() !== null || !query().trim()}
                    onClick={() => void run("gbrain", "search", { query: query().trim() })}
                  >
                    Search
                  </SettingsToolbarAction>
                  <SettingsToolbarAction
                    disabled={busy() !== null || !query().trim()}
                    variant="primary"
                    onClick={() => void run("gbrain", "query", { query: query().trim() })}
                  >
                    Query
                  </SettingsToolbarAction>
                </div>
              </div>

              <div class="grid gap-2 @md:grid-cols-[minmax(0,1fr)_auto]">
                <SettingsInput
                  value={slug()}
                  placeholder="Page slug"
                  onInput={(event) => setSlug(event.currentTarget.value)}
                />
                <div class="flex flex-wrap gap-2">
                  <SettingsToolbarAction
                    disabled={busy() !== null}
                    onClick={() => void run("gbrain", "listPages")}
                  >
                    List
                  </SettingsToolbarAction>
                  <SettingsToolbarAction
                    disabled={busy() !== null || !slug().trim()}
                    onClick={() => void run("gbrain", "getPage", { slug: slug().trim() })}
                  >
                    Get
                  </SettingsToolbarAction>
                  <SettingsToolbarAction
                    disabled={busy() !== null || !slug().trim()}
                    onClick={() => void run("gbrain", "backlinks", { slug: slug().trim() })}
                  >
                    Backlinks
                  </SettingsToolbarAction>
                  <SettingsToolbarAction
                    disabled={busy() !== null || !slug().trim()}
                    onClick={() => void run("gbrain", "graph", { slug: slug().trim() })}
                  >
                    Graph
                  </SettingsToolbarAction>
                  <SettingsToolbarAction
                    disabled={busy() !== null || !slug().trim()}
                    onClick={() => void run("gbrain", "timeline", { slug: slug().trim() })}
                  >
                    Timeline
                  </SettingsToolbarAction>
                </div>
              </div>

              <SettingsTextarea
                value={pageContent()}
                placeholder="Draft page content..."
                onInput={(event) => setPageContent(event.currentTarget.value)}
              />
              <div class="flex justify-end">
                <SettingsToolbarAction
                  disabled={busy() !== null || !slug().trim() || !pageContent().trim()}
                  variant="warning"
                  onClick={() =>
                    void run("gbrain", "putPage", {
                      slug: slug().trim(),
                      content: pageContent(),
                    })
                  }
                >
                  Put Page
                </SettingsToolbarAction>
              </div>
            </div>
          </SettingsCard>
        </Show>

        <Show when={busy()}>
          {(name) => <SettingsBanner tone="info" description={`Running ${name()}...`} />}
        </Show>
        <Show when={settingsError()}>
          {(message) => <SettingsBanner tone="error" description={message()} />}
        </Show>
        <Show when={result()}>
          <pre class="max-h-64 overflow-auto rounded-xs border border-border bg-bg-secondary p-3 text-[0.6875rem] whitespace-pre-wrap text-text-secondary">
            {parsedResult()}
          </pre>
        </Show>
      </div>
    </SettingsPanel>
  );
}

export { GenericThirdPartySettings };
