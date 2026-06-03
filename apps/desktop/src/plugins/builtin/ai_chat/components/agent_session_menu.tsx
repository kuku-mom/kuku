import { For, Show, createSignal, onCleanup, onMount, type JSX } from "solid-js";

import { chatState, createSession, getActiveSession, isSessionBusy } from "../chat_store";
import type { AgentDescriptor } from "../types";
import { t } from "~/i18n";

interface AgentSessionMenuProps {
  align?: "left" | "right";
  defaultOpen?: boolean;
}

function AgentSessionMenu(props: AgentSessionMenuProps): JSX.Element {
  const [open, setOpen] = createSignal(props.defaultOpen ?? false);
  let rootRef: HTMLDivElement | undefined;
  const canCreate = () => !chatState.isCreatingSession && !isSessionBusy(getActiveSession());
  const nativeAgents = () => chatState.agents.filter((agent) => agent.kind === "native");
  const externalAgents = () => chatState.agents.filter((agent) => agent.kind === "acp");
  const alignmentClass = () => (props.align === "right" ? "right-0" : "left-0");

  const createForAgent = (agent: AgentDescriptor) => {
    if (!canCreate() || !agent.enabled) return;
    setOpen(false);
    void createSession(chatState.selectedMode, agent.id);
  };

  onMount(() => {
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!open()) return;
      const target = event.target;
      if (target instanceof Node && rootRef?.contains(target)) return;
      setOpen(false);
    };

    document.addEventListener("pointerdown", closeOnOutsidePointer);
    onCleanup(() => document.removeEventListener("pointerdown", closeOnOutsidePointer));
  });

  return (
    <div
      class="relative"
      ref={(element) => {
        rootRef = element;
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") setOpen(false);
      }}
    >
      <button
        type="button"
        data-kuku-new-chat-session="true"
        class="flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-bg-secondary text-text-secondary transition enabled:hover:border-border-strong enabled:hover:bg-ghost-hover enabled:hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
        title={t("chat.header.new_session")}
        aria-label={t("chat.header.new_session")}
        aria-haspopup="menu"
        aria-expanded={open() ? "true" : "false"}
        disabled={!canCreate()}
        onClick={() => setOpen((current) => !current)}
      >
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
        >
          <path d="M12 5v14" />
          <path d="M5 12h14" />
        </svg>
      </button>

      <Show when={open()}>
        <div
          role="menu"
          data-kuku-agent-session-menu="true"
          class={`absolute top-full ${alignmentClass()} z-1000 mt-1 w-44 overflow-hidden rounded-sm border border-border/40 bg-bg-elevated p-1.5 [box-shadow:var(--shadow-context-surface)]`}
        >
          <For each={nativeAgents()}>
            {(agent) => <AgentMenuItem agent={agent} onSelect={createForAgent} />}
          </For>

          <Show when={externalAgents().length > 0}>
            <div class="px-2.5 py-1.5 text-[0.6875rem] font-medium tracking-wider text-text-muted uppercase">
              {t("chat.agent_selector.external_agents")}
            </div>
            <For each={externalAgents()}>
              {(agent) => <AgentMenuItem agent={agent} onSelect={createForAgent} />}
            </For>
          </Show>
        </div>
      </Show>
    </div>
  );
}

function AgentMenuItem(props: {
  agent: AgentDescriptor;
  onSelect: (agent: AgentDescriptor) => void;
}): JSX.Element {
  return (
    <button
      type="button"
      role="menuitem"
      data-kuku-agent-session-menu-item={props.agent.id}
      class="flex h-8 w-full cursor-pointer items-center justify-between gap-4 rounded-xs px-2.5 text-left text-[0.8125rem] leading-normal text-text-primary outline-none transition-colors duration-75 hover:bg-ghost-hover disabled:cursor-not-allowed disabled:text-text-disabled"
      disabled={!props.agent.enabled}
      onClick={() => props.onSelect(props.agent)}
    >
      <span class="min-w-0 truncate">{props.agent.label}</span>
      <Show when={!props.agent.enabled}>
        <span class="shrink-0 text-[0.6875rem] text-text-muted">
          {t("chat.agent_selector.not_configured")}
        </span>
      </Show>
    </button>
  );
}

export { AgentSessionMenu };
