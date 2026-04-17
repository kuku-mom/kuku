// ── AI Edit Input ──
//
// Floating inline prompt input for "Edit with AI".
//
// When the user triggers "Edit with AI" (via context menu or ⌘⌃E),
// this component renders a small floating text input anchored near
// the current editor selection. The user types a free-form instruction
// (e.g. "make it more concise", "translate to Korean", "add examples"),
// and on Enter the instruction is sent to the AI Chat panel in Inline mode.
//
// The selected text and active file context are attached by the chat store.
// Do not manually embed selected text into the prompt here.
//
// Positioning uses ProseMirror's `coordsAtPos()` to find the screen
// coordinates of the selection head, then offsets the input below
// (or above, if near the bottom of the viewport).

import { createSignal, onCleanup, onMount, Show } from "solid-js";

import { SparklesIcon } from "~/components/icons";
import { computeFloatingOverlayPosition } from "~/components/editor/floating_overlay_position";
import { getActiveEditorInstance } from "~/components/editor/system/editor_engine";
import { sendMessage, switchMode } from "~/plugins/builtin/ai_chat/chat_store";
import { openRightPanelView } from "~/stores/layout";

// ── Types ──

interface AiEditInputProps {
  /** Called after the prompt is sent or when the user dismisses the input. */
  onClose: () => void;
  viewportEl?: HTMLElement;
}

interface AnchorPosition {
  top: number;
  left: number;
  width: number;
  flip: boolean;
}

/**
 * Compute the anchor position for the floating input, based on the
 * current editor selection's screen coordinates.
 *
 * Uses `view.coordsAtPos()` to get the pixel position of the
 * selection head. The input is placed below the selection by default,
 * or above it if there isn't enough room at the bottom.
 */
function computeAnchorPosition(
  containerEl: HTMLElement,
  viewportEl?: HTMLElement,
): AnchorPosition | null {
  const editor = getActiveEditorInstance();
  if (!editor?.view) return null;

  const { head } = editor.view.state.selection;
  let coords: { top: number; bottom: number; left: number };

  try {
    coords = editor.view.coordsAtPos(head);
  } catch {
    return null;
  }

  const containerRect = containerEl.getBoundingClientRect();
  const position = computeFloatingOverlayPosition({
    anchorRect: coords,
    containerRect,
    viewportRect: (viewportEl ?? containerEl).getBoundingClientRect(),
    overlayWidth: 320,
    overlayHeight: 44,
  });

  return {
    top: position.top,
    left: position.left,
    width: position.width,
    flip: position.flip,
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
    requestAnimationFrame(() => {
      if (containerRef?.parentElement) {
        setPosition(computeAnchorPosition(containerRef.parentElement, props.viewportEl));
      }
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

    setSending(true);

    // Open chat panel and send the instruction through Inline mode.
    openRightPanelView("ai-chat.panel");
    await switchMode("inline");

    // Small delay to let the panel mount
    await new Promise((r) => setTimeout(r, 80));

    try {
      await sendMessage(text, { includeSelectedText: true });
    } catch {
      // Chat panel will display the error
    } finally {
      setSending(false);
      props.onClose();
    }
  }

  function handleKeyDown(e: KeyboardEvent): void {
    e.stopPropagation();

    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      return;
    }

    if (e.key === "Escape") {
      e.preventDefault();
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
            class="pointer-events-auto absolute flex items-center gap-2 rounded-sm border border-border bg-bg-elevated px-2.5 py-1.5 shadow-popover"
            style={{
              top: `${anchor().top}px`,
              left: `${anchor().left}px`,
              width: `${anchor().width}px`,
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
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
