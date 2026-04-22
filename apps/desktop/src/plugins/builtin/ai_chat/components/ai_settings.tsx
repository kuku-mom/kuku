import { For, Show, createEffect, createMemo, createSignal, on, type JSX } from "solid-js";

import { chatState, loadConfig, loadTools, saveConfig } from "../chat_store";
import { formatToolIdentity, getToolInfo } from "../tool_identity";
import { ChevronIcon, EyeIcon, EyeOffIcon } from "~/components/icons";
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
import { openSettings } from "~/stores/files";

function openAccountSettings(): void {
  openSettings({
    kind: "plugin",
    fillId: "core-auth.settings",
    anchor: "session",
  });
}

function shortModelLabel(modelId: string): string {
  if (!modelId) return "—";
  if (modelId.includes("gemini-3.1-flash")) return "Gemini 3.1 Flash (preview)";
  if (modelId.includes("flash")) return "Gemini Flash";
  if (modelId.includes("pro")) return "Gemini Pro";
  return modelId;
}

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

  const isUnsaved = createMemo(() => {
    if (chatState.config.loading) return false;
    return (
      provider() !== chatState.config.provider ||
      apiKey() !== chatState.config.apiKey ||
      serverUrl() !== chatState.config.serverUrl
    );
  });

  return (
    <SettingsPanel
      title="AI Chat"
      description="Hook up the side-panel assistant: pick a connection, save, then chat from the right side of the app."
      action={
        <SettingsToolbarAction
          variant="primary"
          disabled={chatState.config.saving}
          class={isUnsaved() ? "ring-2 ring-warning/60 ring-offset-1 ring-offset-bg-primary" : ""}
          onClick={() => void saveConfig(provider(), apiKey(), model(), serverUrl())}
        >
          {chatState.config.saving ? "Saving…" : isUnsaved() ? "Save (required)" : "Save"}
        </SettingsToolbarAction>
      }
    >
      <Show when={isUnsaved()}>
        <SettingsBanner
          tone="warning"
          title="Not saved yet"
          description="Press Save at the top of this page before you leave, or the API key, connection, and other changes here will not be used in chat."
        />
      </Show>
      <SettingsBanner
        tone="info"
        class="select-text"
        title="Quick guide"
        description={
          <ol class="mt-1.5 list-decimal space-y-1.5 pl-4 text-[0.75rem] leading-relaxed text-text-secondary [&_a]:text-text-primary [&_a]:underline [&_a]:underline-offset-2">
            <li>
              <strong class="text-text-primary">Connection:</strong> “Kuku” uses the account
              you’re signed in with. If you already use a Kuku account, that’s the easy path: sign
              in once and you’re good — you usually don’t need to tweak this page. “My Gemini API
              key” is for your own key from Google’s{" "}
              <a
                href="https://aistudio.google.com/apikey"
                target="_blank"
                rel="noreferrer"
                class="whitespace-nowrap"
              >
                AI Studio
              </a>{" "}
              (free tier is enough to try).
            </li>
            <li>
              <strong class="text-text-primary">Save</strong> after you change anything. A green
              or quiet success means you’re good.
            </li>
            <li>
              <strong class="text-text-primary">Open chat:</strong> use the right sidebar tab or
              the command to open the panel, then type in the box at the bottom.
            </li>
          </ol>
        }
      />

      <SettingsBanner
        tone="info"
        class="select-text"
        title="Have a Kuku account?"
        description="Log in and choose “Kuku (signed in)” — then chat just works; this screen is only for picking that mode, your key, or saving. Sign-in, session, and AI permissions are all in Account."
        action={
          <SettingsToolbarAction variant="primary" onClick={openAccountSettings}>
            Open Account
          </SettingsToolbarAction>
        }
      />

      <SettingsFieldRow
        label="Connection"
        description="Start with Kuku if you’re logged in. Switch to your own key only if you need it."
        control={
          <div class="w-full max-w-72">
            <SettingsSelect
              options={[
                { value: "remote", label: "Kuku (signed in) — easiest" },
                { value: "gemini", label: "My Gemini API key" },
              ]}
              value={provider()}
              onChange={(value) => setProvider(value as "gemini" | "remote")}
            />
          </div>
        }
      />

      <Show when={provider() === "remote"}>
        <SettingsFieldRow
          label="Model"
          description="Managed for you. You can’t change it here; it updates when the app updates."
          control={
            <div class="w-full max-w-sm">
              <SettingsInput
                type="text"
                value={shortModelLabel(model())}
                readOnly
                class="text-text-secondary"
              />
            </div>
          }
        />
        <SettingsBanner
          tone="info"
          class="!py-2.5"
          title="While you’re on Kuku"
          description="No API key in this screen — you already authorized the app with your Kuku / Google sign-in. If chat says it’s not allowed, check Account in settings."
        />
      </Show>

      <Show when={provider() === "gemini"}>
        <SettingsBanner
          tone="info"
          class="!py-2.5 select-text"
          title="Using your own key"
          description={
            <ol class="mt-1.5 list-decimal space-y-1.5 pl-4 text-[0.75rem] text-text-secondary">
              <li>Open Google AI Studio (link in Quick guide above).</li>
              <li>Create a key, copy it once — you won’t see the full value again.</li>
              <li>Paste it below, then press Save. The key stays in this app on this device.</li>
            </ol>
          }
        />

        <SettingsFieldRow
          stacked
          label="Gemini API key"
          description="The field is hidden by default. Use the eye to double-check you pasted the whole key."
          control={
            <div data-settings-anchor="api-key" class="w-full max-w-md space-y-1.5">
              <div class="relative w-full">
                <SettingsInput
                  type={showApiKey() ? "text" : "password"}
                  value={apiKey()}
                  placeholder="Paste your key here"
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
                  title={showApiKey() ? "Hide key" : "Show key"}
                >
                  <Show when={showApiKey()} fallback={<EyeIcon size={14} />}>
                    <EyeOffIcon size={14} />
                  </Show>
                </button>
              </div>
              <Show when={isUnsaved() && apiKey().trim() !== ""}>
                <p class="text-[0.6875rem] font-medium text-warning" role="status">
                  Not saved — press <span class="text-text-primary">Save</span> at the top so chat
                  can use this key.
                </p>
              </Show>
            </div>
          }
        />

        <SettingsFieldRow
          label="Model"
          description="Same for everyone with a personal key; you can’t pick another model in this build."
          control={
            <div class="w-full max-w-sm">
              <SettingsInput
                type="text"
                value={shortModelLabel(model())}
                readOnly
                class="text-text-secondary"
              />
            </div>
          }
        />
      </Show>

      <Show when={chatState.config.error}>
        {(error) => <SettingsBanner tone="error" description={error()} />}
      </Show>
      <Show when={chatState.config.toolsError}>
        {(error) => <SettingsBanner tone="error" description={error()} />}
      </Show>

      <SettingsCard
        title="What the AI can do"
        description="Search notes, read or edit files, and reply in the side panel. It will ask before destructive steps when needed."
        tone="subtle"
      >
        <Show when={chatState.config.toolsLoading}>
          <p class="text-[0.75rem] text-text-muted">Loading the feature list…</p>
        </Show>
        <Show
          when={!chatState.config.toolsLoading && chatState.config.availableTools.length > 0}
        >
          <p class="text-[0.75rem] text-text-muted">
            {chatState.config.availableTools.length} feature
            {chatState.config.availableTools.length === 1 ? "" : "s"} ready on the server. You
            don’t have to read the list to use chat.
          </p>
          <details class="kuku-ai-tools-details mt-3 overflow-hidden rounded-sm border border-border/90 bg-bg-secondary/50 transition-shadow hover:border-border">
            <summary class="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5 pr-2 text-left marker:content-none select-none [&::-webkit-details-marker]:hidden">
              <span class="flex min-w-0 items-center gap-2.5">
                <span class="flex size-6 shrink-0 items-center justify-center rounded-xs border border-border/80 bg-bg-elevated/80 text-icon">
                  <ChevronIcon
                    size={14}
                    class="kuku-ai-tools-chevron transition-transform duration-200"
                  />
                </span>
                <span>
                  <span class="block text-[0.8125rem] font-medium text-text-primary">
                    Show the technical tool list
                  </span>
                  <span class="block text-[0.6875rem] text-text-muted">
                    For debugging or curiosity — same names the server uses
                  </span>
                </span>
              </span>
              <span class="shrink-0 rounded-xs border border-border/60 bg-bg-tertiary/80 px-2 py-0.5 text-[0.625rem] font-medium tracking-wide text-text-secondary uppercase">
                tap
              </span>
            </summary>
            <div class="border-t border-border/50 bg-bg-primary/50 px-2.5 py-2">
              <div class="max-h-48 space-y-0.5 overflow-y-auto pr-0.5 select-text">
                <For each={chatState.config.availableTools}>
                  {(tool) => {
                    const identity = () => formatToolIdentity(tool.toolId, tool.name);
                    const info = () => getToolInfo(tool.toolId ?? tool.name);
                    const showIdentity = () => identity() !== info().label;

                    return (
                      <SettingsListRow
                        title={<span class="text-[0.75rem]">{info().label}</span>}
                        description={
                          <span class="block space-y-1">
                            <span class="block text-[0.65rem] leading-snug text-text-secondary">
                              {info().description}
                            </span>
                            <Show when={showIdentity()}>
                              <span class="block whitespace-pre-wrap font-mono text-[0.6rem] text-text-muted/90">
                                {identity()}
                              </span>
                            </Show>
                          </span>
                        }
                      />
                    );
                  }}
                </For>
              </div>
            </div>
          </details>
        </Show>
        <Show
          when={!chatState.config.toolsLoading && chatState.config.availableTools.length === 0}
        >
          <SettingsBanner
            tone="info"
            description="We couldn’t load the feature list. Check your network, then press Save to try again."
          />
        </Show>
      </SettingsCard>
    </SettingsPanel>
  );
}

export { AiSettings };
