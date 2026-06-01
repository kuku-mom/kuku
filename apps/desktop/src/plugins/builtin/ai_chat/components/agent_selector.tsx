import { For, Show, type JSX } from "solid-js";

import { KUKU_NATIVE_AGENT_ID } from "../agent_catalog";
import { chatState, setSelectedAgent } from "../chat_store";
import { t } from "~/i18n";

function AgentSelector(): JSX.Element {
  const nativeAgents = () => chatState.agents.filter((agent) => agent.kind === "native");
  const externalAgents = () => chatState.agents.filter((agent) => agent.kind === "acp");
  const selected = () =>
    chatState.agents.find((agent) => agent.id === chatState.selectedAgentId) ??
    chatState.agents.find((agent) => agent.id === KUKU_NATIVE_AGENT_ID);

  return (
    <div class="flex min-w-0 items-center gap-1">
      <select
        class="hover:border-border-strong h-7 max-w-[9.5rem] rounded-md border border-border bg-bg-secondary px-2 text-[0.6875rem] text-text-primary transition outline-none focus:border-accent disabled:cursor-not-allowed disabled:opacity-60"
        value={chatState.selectedAgentId}
        title={t("chat.agent_selector.select")}
        aria-label={t("chat.agent_selector.select")}
        onChange={(event) => {
          if (!setSelectedAgent(event.currentTarget.value)) {
            event.currentTarget.value = chatState.selectedAgentId;
          }
        }}
      >
        <For each={nativeAgents()}>
          {(agent) => <option value={agent.id}>{agent.label}</option>}
        </For>

        <Show when={externalAgents().length > 0}>
          <optgroup label={t("chat.agent_selector.external_agents")}>
            <For each={externalAgents()}>
              {(agent) => (
                <option value={agent.id} disabled={!agent.enabled}>
                  {agent.label}
                  {!agent.enabled ? ` (${t("chat.agent_selector.not_configured")})` : ""}
                </option>
              )}
            </For>
          </optgroup>
        </Show>
      </select>
      <span class="sr-only">{selected()?.label ?? "Kuku Agent"}</span>
    </div>
  );
}

export { AgentSelector };
