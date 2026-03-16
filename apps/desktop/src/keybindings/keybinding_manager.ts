import { tinykeys } from "tinykeys";

import { executeCommand } from "~/keybindings/command_registry";
import { type KeyboardContext, getKeyboardContext } from "~/keybindings/keyboard_context";

// ── Types ──

interface KeybindingEntry {
  /** Key combo string (tinykeys format, e.g. "$mod+KeyB") */
  keys: string;
  /** Command ID to execute when triggered */
  commandId: string;
  /** Optional condition — binding only fires when this returns true */
  when?: (ctx: KeyboardContext) => boolean;
  /** Whether to call preventDefault (default: true) */
  preventDefault?: boolean;
  /** Whether to fire on key repeat (default: false) */
  allowRepeat?: boolean;
}

// ── State ──

let unsubscribe: (() => void) | null = null;
const bindings: KeybindingEntry[] = [];

// ── API ──

function addKeybinding(entry: KeybindingEntry): void {
  bindings.push(entry);
}

function removeKeybinding(keys: string): void {
  const idx = bindings.findIndex((b) => b.keys === keys);
  if (idx !== -1) bindings.splice(idx, 1);
}

/**
 * Build the tinykeys keymap from all registered bindings and start listening.
 * Must be called after all bindings are added.
 */
function startListening(): void {
  stopListening();

  const keyMap: Record<string, (event: KeyboardEvent) => void> = {};

  for (const binding of bindings) {
    const { commandId, when, preventDefault, allowRepeat } = binding;

    keyMap[binding.keys] = (event: KeyboardEvent) => {
      if (!allowRepeat && event.repeat) return;
      if (when && !when(getKeyboardContext())) return;

      const executed = executeCommand(commandId);
      if (executed) {
        if (preventDefault !== false) event.preventDefault();
        event.stopPropagation();
      }
    };
  }

  unsubscribe = tinykeys(window, keyMap, { event: "keydown" });
}

/**
 * Stop listening for keyboard events.
 * Safe to call multiple times.
 */
function stopListening(): void {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
}

function getAllBindings(): KeybindingEntry[] {
  return [...bindings];
}

// ── Exports ──

export { addKeybinding, getAllBindings, removeKeybinding, startListening, stopListening };
export type { KeybindingEntry };
