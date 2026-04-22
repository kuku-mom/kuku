import { For, Show, createEffect, createSignal, on, type JSX } from "solid-js";

import { chatState, loadConfig, loadTools, saveConfig } from "../chat_store";
import { formatToolIdentity, getToolInfo } from "../tool_identity";
import { EyeIcon, EyeOffIcon } from "~/components/icons";
import {
  SettingsBanner,
  SettingsCard,
  SettingsFieldRow,
  SettingsInput,
  SettingsListRow,
  SettingsPanel,
  SettingsSelect,
  SettingsToolbarAction,
} from "~/components/settings/settings_blocks";
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
    <SettingsPanel
      title="AI Chat"
      description="Configure the model and API access for the AI plugin."
      action={
        <div class="flex items-center gap-2">
          <SettingsToolbarAction onClick={() => void Promise.all([loadConfig(), loadTools()])}>
            Refresh
          </SettingsToolbarAction>
          <SettingsToolbarAction
            variant="primary"
            disabled={chatState.config.saving}
            onClick={() => void saveConfig(provider(), apiKey(), model(), serverUrl())}
          >
            {chatState.config.saving ? "Saving..." : "Save"}
          </SettingsToolbarAction>
        </div>
      }
    >
      <SettingsFieldRow
        label="Provider"
        description="Choose whether requests use a local Gemini key or the Kuku remote server."
        control={
          <div class="w-full max-w-56">
            <SettingsSelect
              options={[
                { value: "gemini", label: "Gemini BYOK" },
                { value: "remote", label: "Kuku Remote" },
              ]}
              value={provider()}
              onChange={(value) => setProvider(value as "gemini" | "remote")}
            />
          </div>
        }
      />

      <Show when={provider() === "remote"}>
        <SettingsFieldRow
          label="Server URL"
          description="The server this app talks to for AI requests."
          control={
            <div class="w-full max-w-80">
              <SettingsInput
                type="url"
                value={serverUrl()}
                placeholder="https://api.kuku.mom"
                readOnly
              />
            </div>
          }
        />
      </Show>

      <Show when={provider() === "gemini"}>
        <SettingsFieldRow
          stacked
          label="API Key"
          description="Gemini AI Studio API key used for BYOK mode."
          control={
            <div data-settings-anchor="api-key" class="relative w-full">
              <SettingsInput
                type={showApiKey() ? "text" : "password"}
                value={apiKey()}
                placeholder="Gemini AI Studio API key"
                class="pr-9"
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
          }
        />
      </Show>

      <SettingsFieldRow
        label="Model"
        description="The AI model the server uses to answer you."
        control={
          <div class="w-full max-w-80">
            <SettingsInput
              type="text"
              value={model()}
              placeholder="gemini-3.1-flash-lite-preview"
              readOnly
            />
          </div>
        }
      />

      <Show when={chatState.config.error}>
        {(error) => <SettingsBanner tone="error" description={error()} />}
      </Show>
      <Show when={chatState.config.toolsError}>
        {(error) => <SettingsBanner tone="error" description={error()} />}
      </Show>

      <SettingsCard
        title="Available Tools"
        description={
          chatState.config.toolsLoading
            ? "Loading tools from the backend."
            : `${chatState.config.availableTools.length} tool(s) available.`
        }
        tone="subtle"
      >
        <Show
          when={chatState.config.availableTools.length > 0}
          fallback={<SettingsBanner tone="info" description="No tools returned by the backend." />}
        >
          <div class="space-y-2">
            <For each={chatState.config.availableTools}>
              {(tool) => {
                const identity = () => formatToolIdentity(tool.toolId, tool.name);
                const info = () => getToolInfo(tool.toolId ?? tool.name);
                const showIdentity = () => identity() !== info().label;

                return (
                  <SettingsListRow
                    title={<span>{info().label}</span>}
                    description={
                      showIdentity()
                        ? `Category: ${tool.category}\nIdentity: ${identity()}`
                        : `Category: ${tool.category}`
                    }
                  />
                );
              }}
            </For>
          </div>
        </Show>
      </SettingsCard>
    </SettingsPanel>
  );
}

export { AiSettings };
