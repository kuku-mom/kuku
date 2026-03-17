// ── Focus Zone ──
//
// Tracks which UI zone has keyboard focus (left panel, center, right, bottom).
// Extracted from keybindings/keyboard_context.ts and backed by the plugin
// system's context_keys store for reactive `when` condition support.
//
// Layout panel components attach focus zones via `createFocusZone(el, zone)`.
// The current focus zone is readable via `getContextKey('focusZone')`.
//
// Usage:
//   <aside ref={(el) => onCleanup(createFocusZone(el, 'left'))}>

import { setContextKey } from "~/plugins/context_keys";

// ── Types ──

/** Well-known panel zones. Custom zones can be any string. */
type FocusZone = "left" | "center" | "right" | "bottom" | (string & {});

// ── API ──

/**
 * Set the currently focused zone. Updates the `focusZone` context key.
 * Pass `null` to clear focus (e.g. when focus leaves all known zones).
 */
function setFocus(zone: FocusZone | null): void {
  setContextKey("focusZone", zone);
}

/**
 * Update the `editorHasSelection` context key.
 * Called by the editor system when the selection state changes.
 */
function setEditorHasSelection(hasSelection: boolean): void {
  setContextKey("editorHasSelection", hasSelection);
}

/**
 * Registers a focus zone on an element.
 * When the element or any descendant receives focus, the zone becomes active.
 * When focus leaves the element entirely, the zone is cleared.
 *
 * Returns a cleanup function to remove the listeners.
 *
 * @example
 * ```tsx
 * <aside ref={(el) => onCleanup(createFocusZone(el, 'left'))}>
 *   ...
 * </aside>
 * ```
 */
function createFocusZone(element: HTMLElement, zone: FocusZone): () => void {
  const onFocusIn = () => setFocus(zone);
  const onFocusOut = (e: FocusEvent) => {
    // Only clear if focus is leaving this zone entirely
    const related = e.relatedTarget as Node | null;
    if (!related || !element.contains(related)) {
      setFocus(null);
    }
  };

  element.addEventListener("focusin", onFocusIn);
  element.addEventListener("focusout", onFocusOut);

  return () => {
    element.removeEventListener("focusin", onFocusIn);
    element.removeEventListener("focusout", onFocusOut);
  };
}

// ── Exports ──

export { createFocusZone, setEditorHasSelection, setFocus };
export type { FocusZone };
