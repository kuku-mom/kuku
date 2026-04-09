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
      title="Account"
      description="Control which plugins can use your Kuku server session."
      action={
        <Show
          when={authState.authenticated}
          fallback={
            <SettingsToolbarAction
              variant="primary"
              disabled={authState.loading}
              onClick={() => void auth()?.login()}
            >
              {authState.loading ? "Opening..." : "Sign in"}
            </SettingsToolbarAction>
          }
        >
          <SettingsToolbarAction onClick={() => void auth()?.logout()}>
            Sign out
          </SettingsToolbarAction>
        </Show>
      }
    >
      <SettingsCard
        anchor="session"
        title="Session"
        description={
          authState.authenticated ? `Signed in as ${authState.user?.email ?? ""}` : "Not signed in"
        }
        action={
          <SettingsStatusBadge tone={authState.authenticated ? "success" : "neutral"}>
            {authState.authenticated ? "Signed in" : "Signed out"}
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
            Manage my account
          </button>
        </Show>
      </SettingsCard>

      <SettingsCard
        anchor="authorizations"
        title="Plugin Access"
        description="Plugins must be explicitly allowed before they can send requests with your server session."
      >
        <Show
          when={authAuthorizations.length > 0}
          fallback={
            <SettingsBanner
              tone="info"
              description="No plugin has requested server session access yet."
            />
          }
        >
          <div class="space-y-2">
            <For each={authAuthorizations}>
              {(item) => (
                <SettingsListRow
                  title={<span>{item.pluginId}</span>}
                  description="Allow this plugin to use your Kuku server session."
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
