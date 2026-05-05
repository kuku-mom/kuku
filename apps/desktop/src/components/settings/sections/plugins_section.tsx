import { createMemo, createSignal, For, Show, type JSX } from "solid-js";
import { invoke } from "@tauri-apps/api/core";

import {
  SettingsBanner,
  SettingsListRow,
  SettingsPanel,
  SettingsStatusBadge,
  SettingsDropdownMenu,
  SettingsToolbarAction,
} from "~/components/settings/settings_blocks";
import { t } from "~/i18n";
import { Switch } from "~/components/ui";
import { getPlugin, getPluginDisplayOrder, registryState } from "~/plugins/registry";
import type { PluginMeta } from "~/plugins/types";
import { setTopLevelSetting, settingsState } from "~/stores/settings";
import { uninstallThirdPartyPlugin } from "~/plugins/third_party/installer";

function PluginsSection(): JSX.Element {
  const [isRestarting, setIsRestarting] = createSignal(false);
  const [notice, setNotice] = createSignal<string | null>(null);
  const [installError, setInstallError] = createSignal<string | null>(null);
  const plugins = createMemo(() => {
    const order = getPluginDisplayOrder();
    const ordered = order
      .map((id) => registryState.plugins[id])
      .filter((plugin): plugin is NonNullable<typeof plugin> => plugin !== undefined);

    const known = new Set(ordered.map((plugin) => plugin.id));
    const remainder = Object.values(registryState.plugins).filter(
      (plugin) => !known.has(plugin.id),
    );

    return [...ordered, ...remainder];
  });

  const isDisabled = (pluginId: string, canDisable: boolean) =>
    canDisable && settingsState.disabledPlugins.includes(pluginId);

  function setPluginDisabled(pluginId: string, canDisable: boolean, disabled: boolean): void {
    if (!canDisable) return;

    const next = disabled
      ? [...new Set([...settingsState.disabledPlugins, pluginId])]
      : settingsState.disabledPlugins.filter((id) => id !== pluginId);

    setTopLevelSetting("disabledPlugins", next);
  }

  function pluginStatus(plugin: PluginMeta): {
    label: string;
    tone: "neutral" | "success" | "error";
  } {
    const disabled = isDisabled(plugin.id, plugin.canDisable);

    if (plugin.id in registryState.failed) {
      return { label: t("settings.plugins.status.failed"), tone: "error" };
    }

    if (disabled) {
      return { label: t("settings.plugins.status.disabled_next_launch"), tone: "neutral" };
    }

    if (!plugin.canDisable) {
      return { label: t("settings.plugins.status.required"), tone: "neutral" };
    }

    if (registryState.activated.includes(plugin.id)) {
      return { label: t("settings.plugins.status.active"), tone: "success" };
    }

    return { label: t("settings.plugins.status.inactive"), tone: "neutral" };
  }

  async function restartApp(): Promise<void> {
    if (isRestarting()) return;

    setIsRestarting(true);

    try {
      await invoke("app_restart");
    } catch {
      setIsRestarting(false);
    }
  }

  async function uninstallPlugin(pluginId: string): Promise<void> {
    setInstallError(null);
    setNotice(null);
    try {
      await uninstallThirdPartyPlugin(pluginId, true);
      setNotice(`Removed ${pluginId}'s package. Restart Kuku to finish deactivation.`);
    } catch (error) {
      setInstallError(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <SettingsPanel
      title={t("settings.plugins.title")}
      description={t("settings.plugins.description")}
      anchor="plugins"
      action={
        <div class="flex items-center gap-2">
          <SettingsToolbarAction disabled={isRestarting()} onClick={() => void restartApp()}>
            {isRestarting()
              ? t("settings.plugins.action.restarting")
              : t("settings.plugins.action.restart")}
          </SettingsToolbarAction>
        </div>
      }
    >
      <div class="space-y-2">
        <Show when={notice()}>
          {(message) => <SettingsBanner tone="success" description={message()} />}
        </Show>
        <Show when={installError()}>
          {(message) => <SettingsBanner tone="error" description={message()} />}
        </Show>
        <Show
          when={plugins().length > 0}
          fallback={<SettingsBanner tone="info" description={t("settings.plugins.empty")} />}
        >
          <For each={plugins()}>
            {(plugin) => {
              const isFailed = () => plugin.id in registryState.failed;
              const failedInfo = () => registryState.failed[plugin.id];
              const disabled = () => isDisabled(plugin.id, plugin.canDisable);
              const status = () => pluginStatus(plugin);
              const dependencies = () => getPlugin(plugin.id)?.dependencies ?? [];
              const dependencyNames = () =>
                dependencies().map(
                  (dependencyId) => registryState.plugins[dependencyId]?.name ?? dependencyId,
                );

              return (
                <SettingsListRow
                  title={
                    <>
                      <span>{plugin.name}</span>
                      <span class="text-[0.625rem] font-normal text-text-muted">
                        v{plugin.version}
                      </span>
                      <Show when={plugin.kind === "third-party"}>
                        <SettingsStatusBadge tone="info" class="text-[0.5rem]">
                          {plugin.id === "gbrain" || plugin.id === "llmwiki"
                            ? "included"
                            : "third-party"}
                        </SettingsStatusBadge>
                      </Show>
                    </>
                  }
                  titleClass="flex items-center gap-2 mb-1"
                  description={
                    <>
                      <span class="text-text-muted">
                        {plugin.description ?? t("settings.plugins.description.none")}
                      </span>

                      <Show when={dependencies().length}>
                        <span class="mt-1 block text-[0.5rem] text-text-muted">
                          {t("settings.plugins.depends_on")} {dependencyNames().join(", ")}
                        </span>
                      </Show>
                      <Show when={isFailed()}>
                        <span class="mt-1 block text-error">
                          {t("settings.plugins.error")}: {failedInfo()?.error}
                        </span>
                      </Show>
                    </>
                  }
                  meta={
                    <SettingsStatusBadge class="m-0 text-[0.5rem]" tone={status().tone}>
                      {status().label}
                    </SettingsStatusBadge>
                  }
                  metaClass="ml-auto flex flex-center"
                  action={
                    <div class="flex items-center gap-2">
                      <Switch
                        checked={!disabled()}
                        disabled={!plugin.canDisable}
                        onChange={(enabled) =>
                          setPluginDisabled(plugin.id, plugin.canDisable, !enabled)
                        }
                      />
                      <Show
                        when={
                          plugin.kind === "third-party" &&
                          plugin.id !== "gbrain" &&
                          plugin.id !== "llmwiki"
                        }
                      >
                        <SettingsDropdownMenu
                          label="More"
                          triggerClass="px-2 py-1 text-[0.625rem]"
                          groups={[
                            {
                              items: [
                                {
                                  label: "Uninstall package",
                                  onSelect: () => void uninstallPlugin(plugin.id),
                                },
                              ],
                            },
                          ]}
                        />
                      </Show>
                    </div>
                  }
                />
              );
            }}
          </For>
        </Show>
      </div>
    </SettingsPanel>
  );
}

export { PluginsSection };
