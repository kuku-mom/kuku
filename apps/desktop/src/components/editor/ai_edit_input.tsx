// ── AI Edit Input ──
//
// Phase 5: Floating inline prompt input for "Edit with AI".
//
// When the user triggers "Edit with AI" (via context menu or ⌘⌃E),
// this component renders a small floating text input anchored near
// the current editor selection. The user types a free-form instruction
// (e.g. "make it more concise", "translate to Korean", "add examples"),
// and on Enter the instruction + selected text are composed into a
// prompt and sent to the AI Chat panel.
//
// Positioning uses ProseMirror's `coordsAtPos()` to find the screen
// coordinates of the selection head, then offsets the input below
// (or above, if near the bottom of the viewport).

import { createSignal, onCleanup, onMount, Show } from "solid-js";

import { SparklesIcon } from "~/components/icons";
import { getActiveEditorInstance } from "~/components/editor/system/editor_engine";
import { sendMessage, setSelectedMode } from "~/plugins/builtin/ai_chat/chat_store";
import { openRightPanelView } from "~/stores/layout";

// ── Types ──

interface AiEditInputProps {
  /** Called after the prompt is sent or when the user dismisses the input. */
  onClose: () => void;
}

interface AnchorPosition {
  top: number;
  left: number;
  flip: boolean;
}

// ── Helpers ──

/**
 * Get the plain text of the current editor selection.
 * Returns null when no text is selected.
 */
function getSelectedText(): string | null {
  const editor = getActiveEditorInstance();
  if (!editor?.view) return null;

  const { from, to, empty } = editor.view.state.selection;
  if (empty) return null;

  return editor.view.state.doc.textBetween(from, to, "\n");
}

/**
 * Compute the anchor position for the floating input, based on the
 * current editor selection's screen coordinates.
 *
 * Uses `view.coordsAtPos()` to get the pixel position of the
 * selection head. The input is placed below the selection by default,
 * or above it if there isn't enough room at the bottom.
 */
function computeAnchorPosition(containerEl: HTMLElement): AnchorPosition | null {
  const editor = getActiveEditorInstance();
  if (!editor?.view) return null;

  const { head } = editor.view.state.selection;
  let coords: { top: number; bottom: number; left: number };

  try {
    coords = editor.view.coordsAtPos(head);
  } catch {
    return null;
  }

  // Convert screen coordinates to container-relative coordinates
  const containerRect = containerEl.getBoundingClientRect();

  const relativeTop = coords.bottom - containerRect.top;
  const relativeLeft = Math.max(0, coords.left - containerRect.left);

  // If the anchor would place the input below the visible area, flip above
  const INPUT_HEIGHT = 44;
  const MARGIN = 8;
  const flip = relativeTop + INPUT_HEIGHT + MARGIN > containerRect.height;

  return {
    top: flip ? coords.top - containerRect.top - INPUT_HEIGHT - MARGIN : relativeTop + MARGIN,
    left: Math.min(relativeLeft, containerRect.width - 320),
    flip,
  };
}

// ── Component ──

export default function AiEditInput(props: AiEditInputProps) {
  let inputRef: HTMLInputElement | undefined;
  let containerRef: HTMLDivElement | undefined;

  const [instruction, setInstruction] = createSignal("");
  const [sending, setSending] = createSignal(false);
  const [position, setPosition] = createSignal<AnchorPosition | null>(null);

  // ── Lifecycle ──

  onMount(() => {
    // Compute initial position
    if (containerRef?.parentElement) {
      setPosition(computeAnchorPosition(containerRef.parentElement));
    }

    // Focus the input after a short delay to let the DOM settle
    requestAnimationFrame(() => {
      inputRef?.focus();
    });

    // Close on outside clicks
    const handlePointerDown = (e: PointerEvent) => {
      if (containerRef && !containerRef.contains(e.target as Node)) {
        props.onClose();
      }
    };
    document.addEventListener("pointerdown", handlePointerDown, true);

    onCleanup(() => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
    });
  });

  // ── Handlers ──

  async function handleSubmit(): Promise<void> {
    const text = instruction().trim();
    if (!text || sending()) return;

    const selected = getSelectedText();

    // Build the prompt — include selected text when available
    const prompt = selected
      ? `[Edit instruction]: ${text}\n\n` +
        `[Selected text to edit]:\n${selected}\n\n` +
        `Apply the instruction to the selected text. ` +
        `Output ONLY the edited result without any explanation.`
      : text;

    setSending(true);

    // Open chat panel and send
    openRightPanelView("ai-chat.panel");
    setSelectedMode("ask");

    // Small delay to let the panel mount
    await new Promise((r) => setTimeout(r, 80));

    try {
      await sendMessage(prompt, { includeSelectedText: false });
    } catch {
      // Chat panel will display the error
    } finally {
      setSending(false);
      props.onClose();
    }
  }

  function handleKeyDown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      props.onClose();
      // Restore editor focus
      requestAnimationFrame(() => {
        getActiveEditorInstance()?.view?.focus();
      });
      return;
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSubmit();
      return;
    }
  }

  // ── Render ──

  const pos = () => position();

  return (
    <div
      ref={containerRef}
      class="pointer-events-none absolute inset-0 z-50"
      style={{ overflow: "visible" }}
    >
      <Show when={pos()}>
        {(anchor) => (
          <div
            class="pointer-events-auto absolute flex w-80 items-center gap-2 rounded-sm border border-border bg-bg-secondary px-2.5 py-1.5"
            classList={{
              "shadow-[0_4px_16px_rgba(0,0,0,0.20),0_0_0_1px_rgba(0,0,0,0.04)]": true,
            }}
            style={{
              top: `${anchor().top}px`,
              left: `${Math.max(8, anchor().left)}px`,
            }}
          >
            <span class="flex shrink-0 items-center text-accent">
              <SparklesIcon size={14} />
            </span>

            <input
              ref={inputRef}
              type="text"
              class="min-w-0 flex-1 bg-transparent text-[0.8125rem]/7 text-text-primary outline-none placeholder:text-text-muted"
              placeholder={sending() ? "Sending..." : "Edit instruction..."}
              value={instruction()}
              onInput={(e) => setInstruction(e.currentTarget.value)}
              onKeyDown={handleKeyDown}
              disabled={sending()}
            />

            <Show when={!sending()}>
              <kbd class="shrink-0 text-[0.625rem] text-text-muted">↵</kbd>
            </Show>

            <Show when={sending()}>
              <span class="shrink-0 animate-pulse text-[0.625rem] text-text-muted">···</span>
            </Show>
          </div>
        )}
      </Show>
    </div>
  );
}
