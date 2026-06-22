import { For, Show, createMemo, type JSX } from "solid-js";

import { t } from "~/i18n";
import { vaultState } from "~/stores/vault";

import { chatState, sendMessage, switchMode } from "../chat_store";
import { STANDARD_FILES, getFolderProjectSnapshot } from "../folder_scope";
import type { ChatMode } from "../types";

interface QuickAction {
  label: Parameters<typeof t>[0];
  mode: ChatMode;
  prompt: string;
}

const QUICK_ACTIONS: QuickAction[] = [
  {
    label: "chat.folder_overview.action.summary",
    mode: "ask",
    prompt: "Summarize the current state of this folder using project_context.",
  },
  {
    label: "chat.folder_overview.action.next",
    mode: "ask",
    prompt: "Show the next actions for this folder using project_next_steps.",
  },
  {
    label: "chat.folder_overview.action.handoff",
    mode: "agent",
    prompt: "Create a Codex handoff proposal for this folder.",
  },
  {
    label: "chat.folder_overview.action.scaffold",
    mode: "agent",
    prompt: "Set up missing Folder Agent standard files for this folder with a proposal.",
  },
];

function FolderAgentOverview(): JSX.Element {
  const snapshot = createMemo(() => {
    const scope = chatState.selectedScope;
    if (scope.kind !== "folder") return null;
    return getFolderProjectSnapshot(vaultState.files, scope.folder);
  });

  const runQuickAction = (action: QuickAction) => {
    void (async () => {
      await switchMode(action.mode);
      await sendMessage(action.prompt, { includeSelectedText: false });
    })();
  };

  return (
    <Show when={snapshot()}>
      {(project) => {
        const missingCount = () => project().missingFiles.length;
        return (
          <div class="mx-auto flex w-full max-w-md flex-col gap-3 px-4 py-6">
            <section
              data-kuku-folder-agent-overview
              class="rounded-md border border-border/70 bg-bg-secondary/35 p-3.5"
            >
              <header class="flex min-w-0 items-start justify-between gap-3">
                <div class="min-w-0">
                  <p class="truncate text-sm font-semibold text-text-primary">{project().folder}</p>
                  <p class="mt-0.5 text-[0.6875rem] text-text-muted">
                    {missingCount() === 0
                      ? t("chat.folder_overview.ready")
                      : t("chat.folder_overview.needs_setup")}
                  </p>
                </div>
                <span
                  class="mt-1 size-2 shrink-0 rounded-full"
                  classList={{
                    "bg-success": missingCount() === 0,
                    "bg-warning": missingCount() > 0,
                  }}
                  aria-hidden="true"
                />
              </header>

              <div class="mt-3 grid grid-cols-3 gap-1.5">
                <For each={STANDARD_FILES}>
                  {(name) => {
                    const present = () => project().presentFiles.includes(name);
                    return (
                      <span
                        class="truncate rounded-sm border px-1.5 py-1 text-center text-[0.625rem] font-medium"
                        classList={{
                          "border-success-border bg-success-bg text-success": present(),
                          "border-warning-border bg-warning-bg text-warning": !present(),
                        }}
                        title={name}
                      >
                        {name.replace(".md", "")}
                      </span>
                    );
                  }}
                </For>
              </div>

              <div class="mt-3 grid grid-cols-3 gap-1.5 text-center">
                <Metric label={t("chat.folder_overview.decisions")} value={project().decisionCount} />
                <Metric label={t("chat.folder_overview.meetings")} value={project().meetingCount} />
                <Metric label={t("chat.folder_overview.proposals")} value={project().proposalCount} />
              </div>

              <div class="mt-3 grid grid-cols-2 gap-1.5">
                <For each={QUICK_ACTIONS}>
                  {(action) => (
                    <button
                      type="button"
                      class="min-h-8 rounded-sm border border-border/70 bg-bg-primary px-2 text-[0.6875rem] font-medium text-text-secondary transition hover:bg-ghost-hover hover:text-text-primary"
                      onClick={() => runQuickAction(action)}
                    >
                      {t(action.label)}
                    </button>
                  )}
                </For>
              </div>
            </section>
          </div>
        );
      }}
    </Show>
  );
}

function Metric(props: { label: string; value: number }): JSX.Element {
  return (
    <div class="rounded-sm border border-border/50 bg-bg-primary/60 px-2 py-1.5">
      <div class="text-sm font-semibold text-text-primary">{props.value}</div>
      <div class="truncate text-[0.625rem] text-text-muted">{props.label}</div>
    </div>
  );
}

export { FolderAgentOverview };
