import { createEffect, onCleanup, onMount } from "solid-js";
import { union } from "prosekit/core";
import { TextSelection } from "prosekit/pm/state";
import { ProseKit, useDocChange, useKeymap } from "prosekit/solid";

import { createKukuEditor, destroyEditor } from "~/components/editor/system/editor_engine";
import type { PMNodeJSON } from "~/lib/markdown";
import { getMarkdownService } from "~/plugins/markdown_service";
import { setContextKey } from "~/plugins/context_keys";
import { defineDiffSchemaExtension, defineReadonly } from "~/plugins/builtin/diff_view";
import {
  getCachedChecksum,
  getCachedContent,
  getViewportState,
  markTabDirty,
  saveCachedChecksum,
  saveCachedContent,
  saveViewportState,
} from "~/stores/files";
import { getDiffEntry } from "~/stores/diff_store";
import { readFileWithChecksum, writeFileWithChecksum } from "~/lib/vault_fs";
import { settingsState } from "~/stores/settings";
import { revealPath, setSelectedPath } from "~/stores/vault";
import { applyPendingSearchNavigation } from "~/plugins/builtin/search/navigation";

import "~/styles/editor.css";
import "~/styles/wikilink.css";
import "~/plugins/builtin/diff_view/diff_view.css";

interface MarkdownEditorProps {
  tabId: string;
  filePath: string;
  mode?: "editable" | "diff";
}

export default function MarkdownEditor(props: MarkdownEditorProps) {
  const mode = props.mode ?? "editable";
  const isDiffMode = mode === "diff";
  const editor = createKukuEditor(
    isDiffMode ? union(defineDiffSchemaExtension(), defineReadonly()) : undefined,
  );
  let disposed = false;
  let settingContent = false;
  let checksum: string | null = null;
  let contentReady = false;
  let autoSaveTimer: number | null = null;
  let saveInFlight: Promise<void> | null = null;
  let inFlightSaveContent: string | null = null;
  let queuedSaveContent: string | null = null;
  let containerRef: HTMLDivElement | undefined;

  function clearAutoSaveTimer(): void {
    if (autoSaveTimer === null) return;
    window.clearTimeout(autoSaveTimer);
    autoSaveTimer = null;
  }

  function scheduleAutoSave(): void {
    clearAutoSaveTimer();
    autoSaveTimer = window.setTimeout(() => {
      autoSaveTimer = null;
      void saveDocument();
    }, 800);
  }

  function getDiffSourcePath(): string | null {
    return getDiffEntry(props.filePath)?.sourceFilePath ?? null;
  }

  function setEditorDocument(content: PMNodeJSON): void {
    settingContent = true;
    try {
      editor.setContent(content, "start");
    } finally {
      settingContent = false;
    }
    contentReady = true;
  }

  function clampSelectionPosition(position: number): number {
    const maxPosition = Math.max(1, editor.view.state.doc.content.size);
    return Math.max(1, Math.min(position, maxPosition));
  }

  function restoreViewportSnapshot(): void {
    const snapshot = getViewportState(props.tabId);
    if (
      snapshot.scrollTop === 0 &&
      snapshot.selectionAnchor === 0 &&
      snapshot.selectionHead === 0 &&
      !snapshot.wasFocused
    ) {
      return;
    }

    requestAnimationFrame(() => {
      if (disposed) return;

      const anchor = clampSelectionPosition(Math.max(1, snapshot.selectionAnchor));
      const head = clampSelectionPosition(Math.max(1, snapshot.selectionHead));

      try {
        const tr = editor.view.state.tr;
        tr.setSelection(TextSelection.create(tr.doc, anchor, head));
        editor.view.dispatch(tr);
      } catch {
        // Ignore invalid selection snapshots.
      }

      if (snapshot.wasFocused) {
        editor.view.focus();
      }
      if (containerRef) {
        containerRef.scrollTop = snapshot.scrollTop;
      }
    });
  }

  function persistEditorRuntimeState(): void {
    if (!contentReady) return;

    saveCachedContent(props.tabId, editor.getDocJSON());

    const { anchor, head } = editor.view.state.selection;
    saveViewportState(props.tabId, {
      scrollTop: containerRef?.scrollTop ?? 0,
      selectionAnchor: anchor,
      selectionHead: head,
      wasFocused: containerRef?.contains(document.activeElement) ?? false,
    });

    if (checksum) {
      saveCachedChecksum(props.tabId, checksum);
    }
  }

  async function loadEditableDocument(): Promise<void> {
    const cachedContent = getCachedContent(props.tabId);
    const cachedChecksum = getCachedChecksum(props.tabId);
    if (cachedContent) {
      setEditorDocument(cachedContent);
      if (cachedChecksum) {
        checksum = cachedChecksum;
      }

      const navigated = applyPendingSearchNavigation(editor, props.filePath, { clearOnMiss: true });
      if (!navigated) {
        restoreViewportSnapshot();
      }

      if (cachedChecksum) {
        return;
      }
    }

    try {
      const result = await readFileWithChecksum(props.filePath);
      if (disposed) return;

      checksum = result.checksum;
      saveCachedChecksum(props.tabId, result.checksum);

      if (cachedContent) {
        return;
      }

      const markdown = getMarkdownService();
      if (!markdown) return;

      const parsed = markdown.parse(result.content);
      setEditorDocument(parsed);
      saveCachedContent(props.tabId, parsed);

      const navigated = applyPendingSearchNavigation(editor, props.filePath, { clearOnMiss: true });
      if (!navigated) {
        restoreViewportSnapshot();
      }

      markTabDirty(props.tabId, false);
    } catch (error) {
      if (disposed) return;
      // oxlint-disable-next-line no-console -- intentional error logging
      console.error("Failed to load document:", error);
    }
  }

  async function loadDiffDocument(): Promise<void> {
    const diffEntry = getDiffEntry(props.filePath);
    if (!diffEntry || disposed) return;

    const content = getCachedContent(props.tabId) ?? diffEntry.diffDoc;
    setEditorDocument(content);
    saveCachedContent(props.tabId, content);
    restoreViewportSnapshot();
    markTabDirty(props.tabId, false);
  }

  function getSaveContent(): string | null {
    clearAutoSaveTimer();
    if (isDiffMode || !checksum) return null;

    const markdown = getMarkdownService();
    if (!markdown) return null;

    const json = editor.getDocJSON();
    return markdown.stringify(json);
  }

  async function saveDocument(): Promise<void> {
    const content = getSaveContent();
    if (content === null) return;

    if (content === queuedSaveContent || content === inFlightSaveContent) {
      await (saveInFlight ?? Promise.resolve());
      return;
    }

    queuedSaveContent = content;
    if (saveInFlight) {
      await saveInFlight;
      return;
    }

    saveInFlight = (async () => {
      while (queuedSaveContent !== null) {
        const contentToWrite = queuedSaveContent;
        queuedSaveContent = null;

        const currentChecksum = checksum;
        if (!currentChecksum) return;

        inFlightSaveContent = contentToWrite;

        try {
          const result = await writeFileWithChecksum(
            props.filePath,
            contentToWrite,
            currentChecksum,
          );

          if (result.status === "Written") {
            checksum = result.checksum;
            saveCachedChecksum(props.tabId, result.checksum);
            saveCachedContent(props.tabId, editor.getDocJSON());
            if (queuedSaveContent === null) {
              markTabDirty(props.tabId, false);
            }
          } else {
            queuedSaveContent = null;
            // oxlint-disable-next-line no-console -- intentional warning for save conflicts
            console.warn("Save conflict:", result);
            return;
          }
        } catch (error) {
          queuedSaveContent = null;
          // oxlint-disable-next-line no-console -- intentional error logging
          console.error("Failed to save document:", error);
          return;
        } finally {
          inFlightSaveContent = null;
        }
      }
    })();

    try {
      await saveInFlight;
    } finally {
      saveInFlight = null;
      inFlightSaveContent = null;
    }
  }

  function handleFocusIn() {
    if (isDiffMode) return;
    setContextKey("editorTextFocus", true);
  }

  function handleFocusOut(e: FocusEvent) {
    if (isDiffMode) return;
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
    persistEditorRuntimeState();
    if (settingsState.general.autoSave && (autoSaveTimer !== null || saveInFlight !== null)) {
      void saveDocument();
    } else {
      clearAutoSaveTimer();
    }
    disposed = true;
    setContextKey("editorTextFocus", false);
    destroyEditor();
  });

  createEffect(() => {
    const targetPath = isDiffMode ? getDiffSourcePath() : props.filePath;
    if (!targetPath) return;

    setSelectedPath(targetPath);
    revealPath(targetPath);
  });

  createEffect(() => {
    if (isDiffMode) {
      void loadDiffDocument();
      return;
    }

    void loadEditableDocument();
  });

  useDocChange(
    () => {
      if (isDiffMode || settingContent || disposed) return;
      markTabDirty(props.tabId, true);
      if (settingsState.general.autoSave) {
        scheduleAutoSave();
      }
    },
    { editor },
  );

  useKeymap(
    () => ({
      "Mod-s": () => {
        if (isDiffMode) {
          return false;
        }

        void saveDocument();
        return true;
      },
    }),
    { editor },
  );

  return (
    <ProseKit editor={editor}>
      <div
        ref={containerRef}
        class="size-full overflow-y-auto bg-bg-primary"
        data-diff-editor={isDiffMode ? "" : undefined}
        spellcheck={!isDiffMode && settingsState.general.spellCheck}
        onFocusIn={handleFocusIn}
        onFocusOut={handleFocusOut}
      >
        <div ref={editor.mount} />
      </div>
    </ProseKit>
  );
}
