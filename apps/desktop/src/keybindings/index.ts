import { registerDefaultCommands, unregisterDefaultCommands } from "~/keybindings/default_commands";
import { startListening, stopListening } from "~/keybindings/keybinding_manager";

// ── Entry points ──

/**
 * Registers all default commands + keybindings, then starts listening.
 * Call once in App onMount.
 */
function initKeybindings(): void {
  registerDefaultCommands();
  startListening();
}

/**
 * Stops listening and unregisters all default commands + keybindings.
 * Call once in App onCleanup.
 */
function destroyKeybindings(): void {
  stopListening();
  unregisterDefaultCommands();
}

// ── Re-exports ──

export type { Command } from "~/keybindings/command_registry";
export {
  executeCommand,
  getAllCommands,
  getCommand,
  registerCommand,
  unregisterCommand,
} from "~/keybindings/command_registry";

export type { KeybindingEntry } from "~/keybindings/keybinding_manager";
export {
  addKeybinding,
  getAllBindings,
  removeKeybinding,
  startListening,
  stopListening,
} from "~/keybindings/keybinding_manager";

export type { FocusZone, KeyboardContext } from "~/keybindings/keyboard_context";
export {
  createFocusZone,
  getKeyboardContext,
  setEditorHasSelection,
  setFocus,
} from "~/keybindings/keyboard_context";

export { initKeybindings, destroyKeybindings };
