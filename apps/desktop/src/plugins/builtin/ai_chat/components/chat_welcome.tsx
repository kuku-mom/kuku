import { For, type JSX } from "solid-js";

import type { ChatMode } from "../types";

interface SuggestedPrompt {
  text: string;
  hint: string;
  prompt: string;
  mode: ChatMode;
}

const SUGGESTED_PROMPTS: SuggestedPrompt[] = [
  {
    text: "Discover hidden connections",
    hint: "Find related notes & map relationships",
    prompt: "Find all notes mentioning this topic and show me how they connect to each other",
    mode: "agent",
  },
  {
    text: "Extract key insights",
    hint: "Summarize & suggest what to explore next",
    prompt:
      "Summarize this document into key insights and suggest 3 follow-up questions I should explore",
    mode: "ask",
  },
  {
    text: "Synthesize new ideas",
    hint: "Generate linked notes from your thoughts",
    prompt:
      "Create a new note that synthesizes my recent thoughts on this topic with proper [[wiki-links]] to existing notes",
    mode: "agent",
  },
  {
    text: "Organize my vault",
    hint: "Find orphans & strengthen connections",
    prompt:
      "Review my vault and identify orphan notes that should be connected, then suggest specific links to add",
    mode: "agent",
  },
];

interface ChatWelcomeProps {
  mode: ChatMode;
  onSubmit: (mode: ChatMode, prompt: string) => void;
}

function ChatWelcome(props: ChatWelcomeProps): JSX.Element {
  return (
    <div class="flex min-h-0 flex-1 flex-col justify-center">
      <div class="mx-auto w-full max-w-md px-4 py-6">
        <header class="mb-8 text-center sm:mb-10">
          <h1 class="text-xl font-semibold tracking-tight text-text-primary sm:text-2xl">Hello</h1>
          <p class="mt-2 text-pretty text-[0.8125rem] leading-relaxed text-text-secondary">
            {props.mode === "agent"
              ? "Your second brain, ready to think with you"
              : "Ask anything about your knowledge base"}
          </p>
        </header>

        <div>
          <p class="mb-2.5 pl-0.5 text-[0.625rem] font-semibold tracking-[0.18em] text-text-muted uppercase">
            Try asking
          </p>
          <div class="overflow-hidden rounded-lg border border-border/80 bg-bg-secondary/40">
            <ul class="divide-y divide-border/70">
              <For each={SUGGESTED_PROMPTS}>
                {(item) => (
                  <li>
                    <button
                      type="button"
                      class="group flex w-full flex-col items-start gap-0.5 px-4 py-3.5 text-left transition hover:bg-ghost-hover active:bg-ghost-active"
                      onClick={() => props.onSubmit(item.mode, item.prompt)}
                    >
                      <span class="text-sm font-medium text-text-primary">{item.text}</span>
                      <span class="text-xs leading-snug text-text-muted">{item.hint}</span>
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

export { ChatWelcome };
