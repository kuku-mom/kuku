import { createEffect, For, on, Show, type JSX } from "solid-js";

import {
  SettingsBanner,
  SettingsCard,
  SettingsListRow,
  SettingsPanel,
  SettingsStatusBadge,
  SettingsToolbarAction,
} from "~/components/settings/settings_blocks";
import { useSettingsRefreshToken } from "~/components/settings/settings_refresh";
import { t, tf } from "~/i18n";
import Switch from "~/components/ui/switch";

import { authAuthorizations, authState, getAuthService } from "./auth_service";

function AuthSettings(): JSX.Element {
  const auth = () => getAuthService();
  const settingsRefreshToken = useSettingsRefreshToken();

  createEffect(
    on(
      settingsRefreshToken,
      () => {
        void auth()?.refresh();
      },
      { defer: false },
    ),
  );

  return (
    <SettingsPanel
      title={t("settings.plugin.account.title")}
      description={t("settings.plugin.account.description")}
      action={
        <Show
          when={authState.authenticated}
          fallback={
            <SettingsToolbarAction
              variant="primary"
              disabled={authState.loading}
              onClick={() => void auth()?.login()}
            >
              {authState.loading
                ? t("settings.plugin.account.action.opening")
                : t("settings.plugin.account.action.sign_in")}
            </SettingsToolbarAction>
          }
        >
          <SettingsToolbarAction onClick={() => void auth()?.logout()}>
            {t("settings.plugin.account.action.sign_out")}
          </SettingsToolbarAction>
        </Show>
      }
    >
      <SettingsCard
        anchor="session"
        title={t("settings.plugin.account.session.title")}
        description={
          authState.authenticated
            ? tf("settings.plugin.account.session.signed_in_as", {
                email: authState.user?.email ?? "",
              })
            : t("settings.plugin.account.session.not_signed_in")
        }
        action={
          <SettingsStatusBadge tone={authState.authenticated ? "success" : "neutral"}>
            {authState.authenticated
              ? t("settings.plugin.account.session.status.signed_in")
              : t("settings.plugin.account.session.status.signed_out")}
          </SettingsStatusBadge>
        }
        bodyClass="my-1"
      >
        <Show when={authState.error}>
          {(error) => <SettingsBanner tone="error" description={error()} />}
        </Show>
        <Show when={authState.authenticated}>
          <button
            type="button"
            class="text-[0.75rem] text-text-muted underline underline-offset-2 transition-colors hover:text-text-primary"
            onClick={() => void auth()?.openAccountDashboard()}
          >
            {t("settings.plugin.account.session.manage")}
          </button>
        </Show>
      </SettingsCard>

      <SettingsCard
        anchor="authorizations"
        title={t("settings.plugin.account.authorizations.title")}
        description={t("settings.plugin.account.authorizations.description")}
      >
        <Show
          when={authAuthorizations.length > 0}
          fallback={
            <SettingsBanner
              tone="info"
              description={t("settings.plugin.account.authorizations.empty")}
            />
          }
        >
          <div class="space-y-2">
            <For each={authAuthorizations}>
              {(item) => (
                <SettingsListRow
                  title={<span>{item.pluginId}</span>}
                  description={t("settings.plugin.account.authorizations.item_description")}
                  action={
                    <Switch
                      checked={item.authorized}
                      onChange={(checked) =>
                        void auth()?.setPluginAuthorized(item.pluginId, checked)
                      }
                    />
                  }
                />
              )}
            </For>
          </div>
        </Show>
      </SettingsCard>
    </SettingsPanel>
  );
}

export { AuthSettings };
