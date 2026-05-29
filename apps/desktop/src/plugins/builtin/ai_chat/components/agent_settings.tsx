import { For, Show, type JSX } from "solid-js";

import { REDACTED_ENV_VALUE, redactedExternalAgentConfig } from "../config";
import type { ExternalAgentConfig } from "../types";
import {
  SettingsBanner,
  SettingsCard,
  SettingsInput,
  SettingsListRow,
} from "~/components/settings/settings_blocks";
import { t } from "~/i18n";

interface AgentSettingsProps {
  agents: ExternalAgentConfig[];
  onChange?: (agents: ExternalAgentConfig[]) => void;
}

function formatArgs(args: string[]): string {
  return args.join(" ");
}

function updateAgent(
  agents: ExternalAgentConfig[],
  id: string,
  update: (agent: ExternalAgentConfig) => ExternalAgentConfig,
): ExternalAgentConfig[] {
  return agents.map((agent) => (agent.id === id ? update(agent) : agent));
}

function parseArgs(value: string): string[] {
  return value
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function formatEnv(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

function parseEnv(value: string, currentEnv: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    value
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const splitAt = line.indexOf("=");
        if (splitAt < 1) return [line, ""] as const;
        const key = line.slice(0, splitAt).trim();
        const envValue = line.slice(splitAt + 1);
        return [
          key,
          envValue === REDACTED_ENV_VALUE ? (currentEnv[key] ?? envValue) : envValue,
        ] as const;
      })
      .filter(([key, envValue]) => key.length > 0 && envValue.length > 0),
  );
}

function AgentSettings(props: AgentSettingsProps): JSX.Element {
  const agents = () => redactedExternalAgentConfig(props.agents);
  const changeAgent = (
    id: string,
    update: (agent: ExternalAgentConfig) => ExternalAgentConfig,
  ): void => {
    props.onChange?.(updateAgent(props.agents, id, update));
  };

  return (
    <SettingsCard
      title={t("settings.plugin.ai_chat.agents.title")}
      description={t("settings.plugin.ai_chat.agents.description")}
      tone="subtle"
      class="scroll-mt-5"
    >
      <div data-settings-anchor="external-agents" class="space-y-2">
        <Show when={agents().length > 0} fallback={<SettingsBanner tone="info" description={t("settings.plugin.ai_chat.agents.empty")} />}>
          <For each={agents()}>
            {(agent) => (
              <SettingsListRow
                title={agent.label}
                meta={
                  <span class="rounded-xs border border-border/60 bg-bg-tertiary/80 px-2 py-0.5 text-[0.625rem] font-medium tracking-wide text-text-secondary uppercase">
                    {agent.enabled
                      ? t("settings.plugin.ai_chat.agents.enabled")
                      : t("settings.plugin.ai_chat.agents.disabled")}
                  </span>
                }
                description={
                  <span class="block space-y-2 select-text">
                    <label class="flex items-center gap-2 text-[0.6875rem] text-text-secondary">
                      <input
                        type="checkbox"
                        checked={agent.enabled}
                        onChange={(event) =>
                          changeAgent(agent.id, (current) => ({
                            ...current,
                            enabled: event.currentTarget.checked,
                          }))
                        }
                      />
                      {agent.enabled
                        ? t("settings.plugin.ai_chat.agents.enabled")
                        : t("settings.plugin.ai_chat.agents.disabled")}
                    </label>
                    <label class="block space-y-1">
                      <span class="block text-[0.625rem] font-medium tracking-wide text-text-muted uppercase">
                        {t("settings.plugin.ai_chat.agents.command")}
                      </span>
                      <SettingsInput
                        value={agent.command}
                        onInput={(event) =>
                          changeAgent(agent.id, (current) => ({
                            ...current,
                            command: event.currentTarget.value,
                          }))
                        }
                      />
                    </label>
                    <label class="block space-y-1">
                      <span class="block text-[0.625rem] font-medium tracking-wide text-text-muted uppercase">
                        {t("settings.plugin.ai_chat.agents.args")}
                      </span>
                      <SettingsInput
                        value={formatArgs(agent.args)}
                        placeholder={t("settings.plugin.ai_chat.agents.args_empty")}
                        onInput={(event) =>
                          changeAgent(agent.id, (current) => ({
                            ...current,
                            args: parseArgs(event.currentTarget.value),
                          }))
                        }
                      />
                    </label>
                    <label class="block space-y-1">
                      <span class="block text-[0.625rem] font-medium tracking-wide text-text-muted uppercase">
                        {t("settings.plugin.ai_chat.agents.env")}
                      </span>
                      <textarea
                        class="min-h-16 w-full resize-y rounded-xs border border-border bg-bg-secondary px-2 py-1.5 font-mono text-[0.6875rem] text-text-primary outline-none transition focus:border-accent"
                        value={formatEnv(agent.env)}
                        spellcheck={false}
                        onInput={(event) =>
                          changeAgent(agent.id, (current) => ({
                            ...current,
                            env: parseEnv(event.currentTarget.value, current.env),
                          }))
                        }
                      />
                    </label>
                  </span>
                }
              />
            )}
          </For>
        </Show>
      </div>
    </SettingsCard>
  );
}

export { AgentSettings };
