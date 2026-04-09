import { For, Show, createEffect, createSignal, on, type JSX } from "solid-js";

import { chatState, loadConfig, loadTools, saveConfig } from "../chat_store";
import { formatToolIdentity, getToolInfo } from "../tool_identity";
import { EyeIcon, EyeOffIcon } from "~/components/icons";
import { useSettingsRefreshToken } from "~/components/settings/settings_refresh";

function AiSettings(): JSX.Element {
  const [apiKey, setApiKey] = createSignal("");
  const [provider, setProvider] = createSignal<"gemini" | "remote">("gemini");
  const [model, setModel] = createSignal("");
  const [serverUrl, setServerUrl] = createSignal("");
  const [showApiKey, setShowApiKey] = createSignal(false);
  const settingsRefreshToken = useSettingsRefreshToken();

  createEffect(
    on(
      settingsRefreshToken,
      () => {
        void Promise.all([loadConfig(), loadTools()]);
      },
      { defer: false },
    ),
  );

  createEffect(() => {
    if (!chatState.config.loading && !chatState.config.saving) {
      setApiKey(chatState.config.apiKey);
      setProvider(chatState.config.provider);
      setModel(chatState.config.model);
      setServerUrl(chatState.config.serverUrl);
    }
  });

  return (
    <div class="overflow-hidden rounded-xs border border-border bg-bg-primary">
      <div class="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div>
          <h3 class="text-[0.8125rem] font-medium text-text-primary">AI Chat</h3>
          <p class="mt-0.5 text-[0.75rem] text-text-muted">
            Configure the model and API access for the AI plugin.
          </p>
        </div>
        <button
          type="button"
          class="rounded-xs border border-border bg-bg-secondary px-2.5 py-1 text-[0.6875rem] text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
          onClick={() => void Promise.all([loadConfig(), loadTools()])}
        >
          Refresh
        </button>
      </div>

      <div class="space-y-3 p-4">
        <label class="block space-y-1.5">
          <span class="text-[0.6875rem] text-text-muted">Provider</span>
          <select
            value={provider()}
            class="w-full rounded-xs border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary transition-colors outline-none focus:border-accent"
            onChange={(event) => setProvider(event.currentTarget.value as "gemini" | "remote")}
          >
            <option value="gemini">Gemini BYOK</option>
            <option value="remote">Kuku Remote</option>
          </select>
        </label>

        <Show when={provider() === "remote"}>
          <label class="block space-y-1.5">
            <span class="text-[0.6875rem] text-text-muted">Server URL</span>
            <input
              type="url"
              value={serverUrl()}
              placeholder="http://localhost:8080"
              class="w-full rounded-xs border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary transition-colors outline-none focus:border-accent"
              onInput={(event) => setServerUrl(event.currentTarget.value)}
            />
          </label>
        </Show>

        <Show when={provider() === "gemini"}>
          <label data-settings-anchor="api-key" class="block space-y-1.5">
            <span class="text-[0.6875rem] text-text-muted">API Key</span>
            <div class="relative">
              <input
                type={showApiKey() ? "text" : "password"}
                value={apiKey()}
                placeholder="Gemini AI Studio API key"
                class="w-full rounded-xs border border-border bg-bg-secondary px-3 py-2 pr-9 text-sm text-text-primary transition-colors outline-none focus:border-accent"
                autocomplete="off"
                spellcheck={false}
                onInput={(event) => setApiKey(event.currentTarget.value)}
              />
              <button
                type="button"
                class="absolute inset-y-0 right-0 flex items-center px-2.5 text-text-muted transition-colors hover:text-text-primary"
                onClick={() => setShowApiKey((prev) => !prev)}
                tabIndex={-1}
                title={showApiKey() ? "Hide API key" : "Show API key"}
              >
                <Show when={showApiKey()} fallback={<EyeIcon size={14} />}>
                  <EyeOffIcon size={14} />
                </Show>
              </button>
            </div>
          </label>
        </Show>

        <label class="block space-y-1.5">
          <span class="text-[0.6875rem] text-text-muted">Model</span>
          <input
            type="text"
            value={model()}
            placeholder="gemini-2.5-flash"
            class="w-full rounded-xs border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary transition-colors outline-none focus:border-accent"
            onInput={(event) => setModel(event.currentTarget.value)}
          />
        </label>

        <div class="flex items-center justify-between gap-2">
          <div class="space-y-1">
            <Show when={chatState.config.error}>
              {(error) => <p class="text-[0.6875rem] text-red-400">{error()}</p>}
            </Show>
            <Show when={chatState.config.toolsError}>
              {(error) => <p class="text-[0.6875rem] text-red-400">{error()}</p>}
            </Show>
          </div>
          <button
            type="button"
            disabled={chatState.config.saving}
            class="ml-auto rounded-xs border border-accent/30 bg-accent/15 px-3 py-1.5 text-xs text-accent transition-colors hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => void saveConfig(provider(), apiKey(), model(), serverUrl())}
          >
            Save
          </button>
        </div>

        <div class="space-y-1.5 rounded-xs border border-border bg-bg-secondary/70 p-3">
          <div class="flex items-center justify-between gap-2">
            <span class="text-[0.6875rem] tracking-[0.12em] text-text-muted uppercase">
              Available Tools
            </span>
            <span class="text-[0.6875rem] text-text-muted">
              {chatState.config.toolsLoading
                ? "Loading..."
                : `${chatState.config.availableTools.length}`}
            </span>
          </div>

          <Show
            when={chatState.config.availableTools.length > 0}
            fallback={
              <p class="text-[0.6875rem] text-text-muted">No tools returned by the backend.</p>
            }
          >
            <div class="flex flex-wrap gap-2">
              <For each={chatState.config.availableTools}>
                {(tool) => {
                  const identity = () => formatToolIdentity(tool.toolId, tool.name);
                  const info = () => getToolInfo(tool.toolId ?? tool.name);
                  const showIdentity = () => identity() !== info().label;

                  return (
                    <div class="rounded-xs border border-border bg-bg-primary px-2.5 py-1 text-[0.6875rem] text-text-secondary">
                      <span class="font-medium text-text-primary">{info().label}</span>
                      <span class="ml-1 text-text-muted">· {tool.category}</span>
                      <Show when={showIdentity()}>
                        <span class="ml-1 text-text-muted">· {identity()}</span>
                      </Show>
                    </div>
                  );
                }}
              </For>
            </div>
          </Show>
        </div>
      </div>
    </div>
  );
}

export { AiSettings };
