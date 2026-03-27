import { For, type JSX } from "solid-js";

import type { ChatMode } from "../types";

interface SuggestedPrompt {
  text: string;
  hint: string;
  prompt: string;
}

const SUGGESTED_PROMPTS: SuggestedPrompt[] = [
  {
    text: "Discover hidden connections",
    hint: "Find related notes & map relationships",
    prompt: "Find all notes mentioning this topic and show me how they connect to each other",
  },
  {
    text: "Extract key insights",
    hint: "Summarize & suggest what to explore next",
    prompt:
      "Summarize this document into key insights and suggest 3 follow-up questions I should explore",
  },
  {
    text: "Synthesize new ideas",
    hint: "Generate linked notes from your thoughts",
    prompt:
      "Create a new note that synthesizes my recent thoughts on this topic with proper [[wiki-links]] to existing notes",
  },
  {
    text: "Organize my vault",
    hint: "Find orphans & strengthen connections",
    prompt:
      "Review my vault and identify orphan notes that should be connected, then suggest specific links to add",
  },
];

interface ChatWelcomeProps {
  mode: ChatMode;
  onSubmit: (prompt: string) => void;
}

function ChatWelcome(props: ChatWelcomeProps): JSX.Element {
  return (
    <div class="flex flex-1 flex-col items-center justify-center px-5 py-4">
      <div class="mb-8 text-center">
        <h1 class="text-xl font-semibold text-text-secondary">Hello</h1>
        <p class="mt-2 text-xs text-text-muted">
          {props.mode === "agent"
            ? "Your second brain, ready to think with you"
            : "Ask anything about your knowledge base"}
        </p>
      </div>

      <div class="w-full max-w-sm space-y-2">
        <div>
          <span class="text-[0.625rem] font-medium tracking-widest text-text-muted uppercase">
            Try asking
          </span>
        </div>
        <div class="space-y-2">
          <For each={SUGGESTED_PROMPTS}>
            {(item) => (
              <button
                type="button"
                class="group flex w-full flex-col gap-1 rounded-xl border border-border bg-bg-secondary/60 px-4 py-3 text-left transition-colors hover:border-border-focused hover:bg-bg-tertiary"
                onClick={() => props.onSubmit(item.prompt)}
              >
                <span class="text-sm text-text-primary/70 group-hover:text-text-primary">
                  {item.text}
                </span>
                <span class="text-xs text-text-muted/70">{item.hint}</span>
              </button>
            )}
          </For>
        </div>
      </div>
    </div>
  );
}

export { ChatWelcome };
