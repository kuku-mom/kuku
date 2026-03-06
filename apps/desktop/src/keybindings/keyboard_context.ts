import { createSignal } from "solid-js";

// ── Types ──

/** Well-known panel zones. Custom zones can be any string. */
type FocusZone = "left" | "center" | "right" | "bottom" | (string & {});

interface KeyboardContext {
  /** Currently focused zone, or null if nothing is focused */
  focus: FocusZone | null;
  /** Whether there is an active text selection in the editor */
  editorHasSelection: boolean;
}

// ── State ──

const [keyboardContext, setKeyboardContext] = createSignal<KeyboardContext>({
  focus: null,
  editorHasSelection: false,
});

// ── Getters ──

function getKeyboardContext(): KeyboardContext {
  return keyboardContext();
}

// ── Setters ──

function setFocus(zone: FocusZone | null): void {
  setKeyboardContext((prev) => ({ ...prev, focus: zone }));
}

function setEditorHasSelection(hasSelection: boolean): void {
  setKeyboardContext((prev) => ({ ...prev, editorHasSelection: hasSelection }));
}

// ── Focus zone utility ──

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

export { createFocusZone, getKeyboardContext, setEditorHasSelection, setFocus };
export type { FocusZone, KeyboardContext };
