import { createEffect, For, on, Show, type JSX } from "solid-js";

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
    <div class="overflow-hidden rounded-xs border border-border bg-bg-primary">
      <div class="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div>
          <h3 class="text-[0.8125rem] font-medium text-text-primary">Account</h3>
          <p class="mt-0.5 text-[0.75rem] text-text-muted">
            Control which plugins can use your Kuku server session.
          </p>
        </div>
        <Show
          when={authState.authenticated}
          fallback={
            <button
              type="button"
              class="rounded-xs border border-accent/30 bg-accent/15 px-2.5 py-1 text-[0.6875rem] text-accent transition-colors hover:bg-accent/25 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={authState.loading}
              onClick={() => void auth()?.login()}
            >
              {authState.loading ? "Opening..." : "Sign in"}
            </button>
          }
        >
          <button
            type="button"
            class="rounded-xs border border-border bg-bg-secondary px-2.5 py-1 text-[0.6875rem] text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
            onClick={() => void auth()?.logout()}
          >
            Sign out
          </button>
        </Show>
      </div>

      <div class="space-y-3 p-4">
        <div
          data-settings-anchor="session"
          class="rounded-xs border border-border bg-bg-secondary/70 p-3"
        >
          <div class="flex items-center justify-between gap-3">
            <div>
              <div class="text-[0.6875rem] tracking-[0.12em] text-text-muted uppercase">
                Session
              </div>
              <p class="mt-1 text-[0.75rem] text-text-muted">
                <Show when={authState.authenticated} fallback="Not signed in">
                  Signed in as{" "}
                  <span class="font-medium text-text-primary">{authState.user?.email}</span>
                </Show>
              </p>
            </div>
            <span
              class="rounded-xs border px-2 py-0.5 text-[0.6875rem]"
              classList={{
                "border-success-border bg-success-bg text-success": authState.authenticated,
                "border-border bg-bg-primary text-text-muted": !authState.authenticated,
              }}
            >
              {authState.authenticated ? "Signed in" : "Signed out"}
            </span>
          </div>
          <Show when={authState.error}>
            {(error) => <p class="mt-2 text-[0.6875rem] text-error">{error()}</p>}
          </Show>
        </div>

        <div
          data-settings-anchor="authorizations"
          class="rounded-xs border border-border bg-bg-secondary/40 p-3"
        >
          <div class="text-[0.6875rem] tracking-[0.12em] text-text-muted uppercase">
            Plugin Access
          </div>
          <p class="mt-1 text-[0.75rem] text-text-muted">
            Plugins must be explicitly allowed before they can send requests with your server
            session.
          </p>

          <Show
            when={authAuthorizations.length > 0}
            fallback={
              <p class="mt-3 rounded-xs border border-border/60 bg-bg-primary/60 px-3 py-2 text-[0.75rem] text-text-muted">
                No plugin has requested server session access yet.
              </p>
            }
          >
            <div class="mt-3 space-y-2">
              <For each={authAuthorizations}>
                {(item) => (
                  <div class="flex items-start justify-between gap-4 rounded-xs border border-border/60 bg-bg-primary/60 px-3 py-2">
                    <div>
                      <div class="text-[0.75rem] font-medium text-text-primary">
                        {item.pluginId}
                      </div>
                      <p class="mt-0.5 text-[0.6875rem] text-text-muted">
                        Allow this plugin to use your Kuku server session.
                      </p>
                    </div>
                    <Switch
                      checked={item.authorized}
                      onChange={(checked) =>
                        void auth()?.setPluginAuthorized(item.pluginId, checked)
                      }
                    />
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>
      </div>
    </div>
  );
}

export { AuthSettings };
