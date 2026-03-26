import { createEffect, createSignal, on, Show } from "solid-js";

import { settingsState } from "~/stores/settings";
import { charCount, isTyping, savedCharCount } from "~/stores/typing";

// ── Component ──

export default function TypingIndicator() {
  const [bounce, setBounce] = createSignal(false);
  const [prevCount, setPrevCount] = createSignal(0);

  // Trigger bounce animation when charCount increases while typing
  createEffect(
    on(charCount, (count) => {
      if (isTyping() && count > prevCount()) {
        setBounce(true);
        const timeout = setTimeout(() => setBounce(false), 300);
        setPrevCount(count);
        return () => clearTimeout(timeout);
      }
    }),
  );

  // Reset prevCount when typing stops
  createEffect(
    on(isTyping, (typing) => {
      if (!typing) setPrevCount(0);
    }),
  );

  // Don't render if disabled in settings
  const enabled = () => settingsState.general.typingIndicator;
  const hasActivity = () => isTyping() || savedCharCount() > 0;

  return (
    <Show when={enabled() && hasActivity()}>
      <div class="flex items-center justify-center border-t border-border px-3 py-2">
        <Show
          when={isTyping()}
          fallback={
            <Show when={savedCharCount() > 0}>
              <div class="flex animate-fade-in items-center gap-1.5">
                <span class="text-xs text-text-muted">✓</span>
                <span class="text-[0.6875rem] text-text-muted">
                  auto saved{" "}
                  <span class="font-semibold text-text-secondary tabular-nums">
                    +{savedCharCount()}
                  </span>
                </span>
              </div>
            </Show>
          }
        >
          <div class="flex animate-fade-in items-baseline gap-1">
            <span
              class="text-[1.375rem] leading-none font-bold text-text-primary tabular-nums"
              classList={{ "animate-bounce-combo": bounce() }}
            >
              {charCount()}
            </span>
            <span class="text-[0.5625rem] text-text-muted opacity-60">char</span>
          </div>
        </Show>
      </div>
    </Show>
  );
}
