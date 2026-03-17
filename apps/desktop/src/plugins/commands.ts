// ── Command Registry ──
//
// Central, single keymap system for ALL commands (global + editor).
// Uses tinykeys on `window` with `capture: true`.
//
// Design decisions (v1.1–v1.3):
// - NO ProseKit defineKeymap() — all user-triggerable keys managed here
// - PM's defineBaseKeymap() still handles structural keys (Enter, Backspace)
// - Focus guard: commands suppressed in input/textarea unless `global: true`
// - Editor commands: call `editorExecute(editor)` when editor is focused
// - Zombie filter: `getVisibleCommands()` hides commands from non-activated plugins
//
// SolidJS module-level singleton — no Context provider needed.

import { createStore } from "solid-js/store";
import { tinykeys } from "tinykeys";

import type { CommandContribution, Disposer, Editor } from "~/plugins/types";

// ── Types ──

interface RegisteredCommand {
  pluginId: string;
  contribution: CommandContribution;
  /** User-overridden keys. When set, takes precedence over `defaultKeys`. */
  userKeys?: string[];
}

interface CommandRegistryState {
  /** All registered commands, keyed by command ID. Used for UI rendering. */
  commands: Record<string, RegisteredCommand>;
}

// ── Store ──

const [cmdState, setCmdState] = createStore<CommandRegistryState>({
  commands: {},
});

// ── Internal ──

let tinykeyUnsubscribe: (() => void) | null = null;

/**
 * Injected by registry.ts to check if a plugin is currently activated.
 * Avoids circular dependency (commands.ts ← registry.ts → commands.ts).
 * Set via `setActivationChecker()` during bootstrap.
 */
let isPluginActivated: (pluginId: string) => boolean = () => true;

/**
 * Injected by the editor system to provide the active editor instance.
 * Returns null when no editor is mounted. Set via `setEditorProvider()`.
 */
let getActiveEditor: () => Editor | null = () => null;

// ── Dependency Injection ──

/**
 * Set the function that checks whether a plugin is activated.
 * Called by registry.ts during system init to avoid circular imports.
 */
function setActivationChecker(fn: (pluginId: string) => boolean): void {
  isPluginActivated = fn;
}

/**
 * Set the function that returns the current active editor instance.
 * Called by editor-engine.ts when the editor system initializes (Stage 4).
 */
function setEditorProvider(fn: () => Editor | null): void {
  getActiveEditor = fn;
}

// ── Focus Guard ──

/**
 * Determine if the keyboard event target is a text input element.
 * When true, most commands should be suppressed to avoid stealing keystrokes.
 *
 * Exceptions:
 * - Commands with `global: true` fire in all contexts
 * - Commands with `editorExecute` fire in contentEditable elements
 */
function isTextInputTarget(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null;
  if (!target) return false;

  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return true;
  if (target.isContentEditable) return true;

  return false;
}

// ── Public API ──

/**
 * Register a command from a plugin.
 * Rebuilds the central keymap immediately.
 * Returns a disposer that unregisters the command.
 */
function registerPluginCommand(pluginId: string, cmd: CommandContribution): Disposer {
  setCmdState("commands", cmd.id, { pluginId, contribution: cmd });
  rebuildKeymap();

  return () => {
    // Use reconcile to actually remove the key (SolidJS store merge semantics)
    setCmdState("commands", (prev) => {
      const next = { ...prev };
      delete next[cmd.id];
      return next;
    });
    rebuildKeymap();
  };
}

/**
 * Update a command's key bindings (user override).
 * Called from the Settings / Keybindings UI.
 */
function updateCommandKeys(commandId: string, newKeys: string[]): void {
  const reg = cmdState.commands[commandId];
  if (!reg) return;

  setCmdState("commands", commandId, "userKeys", newKeys.length > 0 ? newKeys : undefined);
  rebuildKeymap();
}

/**
 * Execute a command by ID (e.g. from Command Palette or menu click).
 * Checks `when` and `canExecute` conditions before running.
 * Tries `editorExecute` first (if editor is available), then falls back to `execute`.
 */
function executePluginCommand(commandId: string): boolean {
  const reg = cmdState.commands[commandId];
  if (!reg) return false;

  const { contribution } = reg;

  // Condition checks
  if (contribution.when && !contribution.when()) return false;
  if (contribution.canExecute && !contribution.canExecute()) return false;

  // Try editor execution first
  if (contribution.editorExecute) {
    const editor = getActiveEditor();
    if (editor) {
      const handled = contribution.editorExecute(editor);
      if (handled) return true;
    }
  }

  // Fall back to global execution
  if (contribution.execute) {
    contribution.execute();
    return true;
  }

  return false;
}

/**
 * Get all commands visible in the Command Palette.
 * Filters out:
 * - Commands from non-activated plugins (zombie command prevention)
 * - Commands whose `when` condition returns false
 */
function getVisibleCommands(): RegisteredCommand[] {
  return Object.values(cmdState.commands).filter((reg) => {
    // v1.3: hide commands from plugins that failed to activate
    if (!isPluginActivated(reg.pluginId)) return false;
    const { when } = reg.contribution;
    return !when || when();
  });
}

/**
 * Get all registered commands (including hidden ones).
 * Used by the Keybindings settings panel to show all possible key bindings.
 */
function getAllCommands(): RegisteredCommand[] {
  return Object.values(cmdState.commands);
}

/**
 * Get the effective key bindings for a command.
 * User override takes precedence over default keys.
 */
function getEffectiveKeys(commandId: string): string[] {
  const reg = cmdState.commands[commandId];
  if (!reg) return [];
  return reg.userKeys ?? reg.contribution.defaultKeys ?? [];
}

// ── Internal: Central Keymap ──

/**
 * Try to execute a single command contribution for a keyboard event.
 * Returns true if the command handled the event, false otherwise.
 *
 * Checks focus guard, `when`, and `canExecute` before attempting execution.
 */
function tryExecuteForEvent(event: KeyboardEvent, contribution: CommandContribution): boolean {
  // ── Focus guard ──
  if (isTextInputTarget(event)) {
    const target = event.target as HTMLElement;
    const isEditorCmd = target.isContentEditable && contribution.editorExecute;
    if (!isEditorCmd && !contribution.global) {
      return false; // Suppress in text inputs
    }
  }

  // ── Condition checks ──
  if (contribution.when && !contribution.when()) return false;
  if (contribution.canExecute && !contribution.canExecute()) return false;

  // ── Execution ──
  // Try editor execution first (when focused in editor)
  if (contribution.editorExecute) {
    const editor = getActiveEditor();
    if (editor) {
      if (contribution.editorExecute(editor)) return true;
    }
  }

  // Fall back to global execution
  if (contribution.execute) {
    contribution.execute();
    return true;
  }

  return false;
}

/**
 * Tear down and rebuild the tinykeys keymap from all registered commands.
 *
 * Uses `capture: true` on window so registered command keys are intercepted
 * before reaching the target element. Unregistered keys (Enter, Backspace, etc.)
 * pass through to ProseMirror's defineBaseKeymap().
 *
 * When multiple commands share the same key (e.g. $mod+B for both
 * "Toggle Bold" and "Toggle Left Panel"), all candidates are collected
 * into a chain and tried in order. The first command whose `when`/`canExecute`
 * conditions pass AND whose execute/editorExecute returns true wins.
 *
 * Focus guard logic (v1.2):
 * - `<input>` / `<textarea>`: only `global` commands fire
 * - `contentEditable` (editor): `global` + `editorExecute` commands fire
 * - Other elements: all commands fire
 */
function rebuildKeymap(): void {
  tinykeyUnsubscribe?.();

  // ── Collect all contributions per key ──
  const keyChains = new Map<string, CommandContribution[]>();

  for (const reg of Object.values(cmdState.commands)) {
    const { contribution } = reg;
    const keys = reg.userKeys ?? contribution.defaultKeys ?? [];

    for (const key of keys) {
      let chain = keyChains.get(key);
      if (!chain) {
        chain = [];
        keyChains.set(key, chain);
      }
      chain.push(contribution);
    }
  }

  // ── Build tinykeys keymap with chain handlers ──
  const keyMap: Record<string, (event: KeyboardEvent) => void> = {};

  for (const [key, chain] of keyChains) {
    keyMap[key] = (event: KeyboardEvent) => {
      for (const contribution of chain) {
        if (tryExecuteForEvent(event, contribution)) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
      }
      // No command handled it — let the event propagate
    };
  }

  tinykeyUnsubscribe = tinykeys(window, keyMap, { event: "keydown", capture: true });
}

/**
 * Destroy the keymap listener. Called during app teardown.
 */
function destroyKeymap(): void {
  tinykeyUnsubscribe?.();
  tinykeyUnsubscribe = null;
}

// ── Exports ──

export {
  cmdState,
  destroyKeymap,
  executePluginCommand,
  getAllCommands,
  getEffectiveKeys,
  getVisibleCommands,
  registerPluginCommand,
  setActivationChecker,
  setEditorProvider,
  updateCommandKeys,
};
export type { RegisteredCommand };
