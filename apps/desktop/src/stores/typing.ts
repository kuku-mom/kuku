import { createSignal } from "solid-js";

// ── Typing Store ──
//
// Tracks typing activity in the editor for the typing indicator.
// - `isTyping`: true while the user is actively typing
// - `charCount`: number of characters typed in the current burst
// - `savedCharCount`: snapshot of charCount when typing stops (for "auto saved +N" display)

const TYPING_TIMEOUT = 1500;

const [isTyping, setIsTyping] = createSignal(false);
const [charCount, setCharCount] = createSignal(0);
const [savedCharCount, setSavedCharCount] = createSignal(0);

let typingTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Call on every document change (e.g. from `useDocChange`) to record typing activity.
 * `chars` is the number of characters inserted/deleted in this transaction.
 */
function recordTyping(chars = 1): void {
  setIsTyping(true);
  setCharCount((prev) => prev + chars);

  if (typingTimer) clearTimeout(typingTimer);

  typingTimer = setTimeout(() => {
    typingTimer = null;
    setIsTyping(false);
    setSavedCharCount(charCount());
    setCharCount(0);
  }, TYPING_TIMEOUT);
}

/** Reset all typing state (e.g. when switching tabs or closing editor). */
function resetTyping(): void {
  if (typingTimer) {
    clearTimeout(typingTimer);
    typingTimer = null;
  }
  setIsTyping(false);
  setCharCount(0);
  setSavedCharCount(0);
}

export { charCount, isTyping, recordTyping, resetTyping, savedCharCount };
