// ── Markdown Editor ──
//
// Top-level editor component. Creates a ProseKit editor instance via
// createKukuEditor(), mounts it to the DOM, and manages the
// `editorTextFocus` context key for keybinding routing.
//
// The editor-core plugin (bold, italic, code, headings) is injected
// automatically during plugin bootstrap — this component only handles
// the visual shell and lifecycle.

import { onCleanup, onMount } from "solid-js";
import { ProseKit } from "prosekit/solid";

import { createKukuEditor, destroyEditor } from "~/components/editor/system/editor_engine";
import { setContextKey } from "~/plugins/context_keys";

import "~/styles/editor.css";

// ── Component ──

export default function MarkdownEditor() {
  const editor = createKukuEditor();

  // ── Focus tracking ──
  // Set `editorTextFocus` context key so keybinding chains can distinguish
  // between editor-focused and non-editor-focused states.
  // (e.g. $mod+B → toggleBold vs toggleLeftPanel)

  function handleFocusIn() {
    setContextKey("editorTextFocus", true);
  }

  function handleFocusOut(e: FocusEvent) {
    // Only clear if focus is leaving the editor entirely
    const related = e.relatedTarget as Node | null;
    const container = e.currentTarget as HTMLElement;
    if (!related || !container.contains(related)) {
      setContextKey("editorTextFocus", false);
    }
  }

  onMount(() => {
    setContextKey("editorTextFocus", false);
  });

  onCleanup(() => {
    setContextKey("editorTextFocus", false);
    destroyEditor();
  });

  return (
    <ProseKit editor={editor}>
      <div
        class="size-full overflow-y-auto bg-bg-primary"
        onFocusIn={handleFocusIn}
        onFocusOut={handleFocusOut}
      >
        <div ref={editor.mount} />
      </div>
    </ProseKit>
  );
}
