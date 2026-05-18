import { For, type JSX } from "solid-js";

import { t } from "~/i18n";
import type { ChatMode } from "../types";

interface SuggestedPrompt {
  intentId:
    | "find_related_notes"
    | "summarize_current_document"
    | "draft_wiki_from_source"
    | "suggest_vault_links";
  text: Parameters<typeof t>[0];
  hint: Parameters<typeof t>[0];
  prompt: Parameters<typeof t>[0];
  mode: ChatMode;
  permissionProfile: "read-only" | "agent-workflow";
}

const SUGGESTED_PROMPTS: SuggestedPrompt[] = [
  {
    intentId: "find_related_notes",
    text: "chat.welcome.s1.text",
    hint: "chat.welcome.s1.hint",
    prompt: "chat.welcome.s1.prompt",
    mode: "agent",
    permissionProfile: "read-only",
  },
  {
    intentId: "summarize_current_document",
    text: "chat.welcome.s2.text",
    hint: "chat.welcome.s2.hint",
    prompt: "chat.welcome.s2.prompt",
    mode: "ask",
    permissionProfile: "read-only",
  },
  {
    intentId: "draft_wiki_from_source",
    text: "chat.welcome.s3.text",
    hint: "chat.welcome.s3.hint",
    prompt: "chat.welcome.s3.prompt",
    mode: "agent",
    permissionProfile: "agent-workflow",
  },
  {
    intentId: "suggest_vault_links",
    text: "chat.welcome.s4.text",
    hint: "chat.welcome.s4.hint",
    prompt: "chat.welcome.s4.prompt",
    mode: "agent",
    permissionProfile: "agent-workflow",
  },
];

type Translate = typeof t;

function getSuggestedPrompts(translate: Translate): Array<
  Omit<SuggestedPrompt, "prompt"> & {
    prompt: string;
  }
> {
  return SUGGESTED_PROMPTS.map((item) => ({
    ...item,
    prompt: translate(item.prompt),
  }));
}

interface ChatWelcomeProps {
  mode: ChatMode;
  onSubmit: (mode: ChatMode, prompt: string) => void;
}

function ChatWelcome(props: ChatWelcomeProps): JSX.Element {
  return (
    <div class="flex min-h-0 flex-1 flex-col justify-center">
      <div class="mx-auto w-full max-w-md px-4 py-6">
        <header class="mb-8 text-center sm:mb-10">
          <h1 class="text-xl font-semibold tracking-tight text-text-primary sm:text-2xl">
            {t("chat.welcome.title")}
          </h1>
          <p class="mt-2 text-[0.8125rem] leading-relaxed text-pretty text-text-secondary">
            {props.mode === "agent"
              ? t("chat.welcome.subtitle.agent")
              : t("chat.welcome.subtitle.ask")}
          </p>
        </header>

        <div>
          <p class="mb-2.5 pl-0.5 text-[0.625rem] font-semibold tracking-[0.18em] text-text-muted uppercase">
            {t("chat.welcome.try_asking")}
          </p>
          <div class="overflow-hidden rounded-lg border border-border/80 bg-bg-secondary/40">
            <ul class="divide-y divide-border/70">
              <For each={getSuggestedPrompts(t)}>
                {(item) => (
                  <li>
                    <button
                      type="button"
                      class="group flex w-full flex-col items-start gap-0.5 px-4 py-3.5 text-left transition hover:bg-ghost-hover active:bg-ghost-active"
                      onClick={() => props.onSubmit(item.mode, item.prompt)}
                    >
                      <span class="text-sm font-medium text-text-primary">{t(item.text)}</span>
                      <span class="text-xs/snug text-text-muted">{t(item.hint)}</span>
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}

export { ChatWelcome, getSuggestedPrompts };
