import { createEffect, createSignal, onCleanup, onMount, Show, untrack } from "solid-js";
import type { OverlayScrollbars } from "overlayscrollbars";
import { union, type Editor } from "prosekit/core";
import { TextSelection } from "prosekit/pm/state";
import { ProseKit, useDocChange, useKeymap } from "prosekit/solid";
import type { OverlayScrollbarsComponentRef } from "overlayscrollbars-solid";

import { createKukuEditor, destroyEditor } from "~/components/editor/system/editor_engine";
import EditorContextMenu from "~/components/editor/editor_context_menu";
import AiEditInput from "~/components/editor/ai_edit_input";
import AnchorEditInput from "~/components/editor/anchor_edit_input";
import EditorSlashMenu from "~/components/editor/editor_slash_menu";
import {
  computeSlashMenuPosition,
  type SlashMenuPosition,
} from "~/components/editor/slash_menu_position";
import ScrollArea from "~/components/scroll_area";
import type { PMNodeJSON } from "~/lib/markdown";
import {
  dispatchAnchorEditResolveFromAnchor,
  type AnchorEditValues,
  type ResolvedAnchorEditor,
} from "~/plugins/anchor_editors";
import {
  filterEditorSlashItems,
  readEditorSlashItemState,
  type EditorSlashItem,
} from "~/plugins/builtin/editor_core/slash_items";
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
import { recordTyping, resetTyping } from "~/stores/typing";
import { readFileWithChecksum, writeFileWithChecksum } from "~/lib/vault_fs";
import { settingsState } from "~/stores/settings";
import { revealPath, setSelectedPath } from "~/stores/vault";
import { applyPendingSearchNavigation } from "~/plugins/builtin/search/navigation";

import BacklinksPanel from "~/plugins/builtin/graph_view/backlinks_panel";

import "~/styles/editor.css";
import "~/plugins/builtin/diff_view/diff_view.css";

interface MarkdownEditorProps {
  tabId: string;
  filePath: string;
  mode?: "editable" | "diff";
}

const HOVER_LINK_OPEN_DELAY_MS = 1000;
const SLASH_MENU_WIDTH = 320;
const SLASH_MENU_MAX_HEIGHT = 320;
const SLASH_TRIGGER_PATTERN = /^(\s*)\/([^\s]*)$/;

interface ResolvedSlashMenu {
  from: number;
  to: number;
  query: string;
  position: SlashMenuPosition;
}

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function isLinkEditorElement(value: EventTarget | null): boolean {
  return value instanceof Element && Boolean(value.closest("[data-link-editor]"));
}

function resolveSlashMenu(
  editor: Editor,
  containerEl: HTMLElement,
  viewportEl?: HTMLElement,
): ResolvedSlashMenu | null {
  const { state } = editor.view;
  const { selection } = state;
  if (!selection.empty) return null;

  const { $from } = selection;
  if (!$from.parent.isTextblock) return null;

  const textBefore = $from.parent.textBetween(0, $from.parentOffset, undefined, "\0");
  const match = SLASH_TRIGGER_PATTERN.exec(textBefore);
  if (!match) return null;

  const { from } = editor.view.state.selection;
  let coords: { top: number; bottom: number; left: number };

  try {
    coords = editor.view.coordsAtPos(from);
  } catch {
    return null;
  }

  const position = computeSlashMenuPosition({
    anchorRect: coords,
    containerRect: containerEl.getBoundingClientRect(),
    viewportRect: (viewportEl ?? containerEl).getBoundingClientRect(),
    menuWidth: SLASH_MENU_WIDTH,
    menuMaxHeight: SLASH_MENU_MAX_HEIGHT,
  });

  const leadingWhitespace = match[1]?.length ?? 0;

  return {
    from: $from.start() + leadingWhitespace,
    to: selection.from,
    query: match[2] ?? "",
    position,
  };
}

export default function MarkdownEditor(props: MarkdownEditorProps) {
  const mode = props.mode ?? "editable";
  const isDiffMode = mode === "diff";
  const editor = createKukuEditor(
    isDiffMode ? union(defineDiffSchemaExtension(), defineReadonly()) : undefined,
  );
  let disposed = false;
  onCleanup(() => resetTyping());
  let settingContent = false;
  let checksum: string | null = null;
  let contentReady = false;
  let autoSaveTimer: number | null = null;
  let saveInFlight: Promise<void> | null = null;
  let inFlightSaveContent: string | null = null;
  let queuedSaveContent: string | null = null;
  let containerRef: HTMLDivElement | undefined;
  let osRef: OverlayScrollbarsComponentRef | undefined;
  let osReady = false;
  let pendingViewportAction: (() => void) | null = null;
  let viewportScrollCleanup: (() => void) | null = null;
  let viewportPersistTimer: number | null = null;
  let lastKnownScrollTop = 0;
  let pendingScrollbarSyncRaf: number | null = null;
  let hoverOpenTimer: number | null = null;
  let pendingHoverAnchor: HTMLAnchorElement | null = null;
  let hoveredAnchor: HTMLAnchorElement | null = null;
  let slashMenuLayoutObserver: ResizeObserver | null = null;

  const [activeAnchorEditor, setActiveAnchorEditor] = createSignal<ResolvedAnchorEditor | null>(
    null,
  );
  const [activeAnchorEditorOrigin, setActiveAnchorEditorOrigin] = createSignal<
    "hover" | "selection" | null
  >(null);
  const [anchorEditorPinned, setAnchorEditorPinned] = createSignal(false);
  const [activeSlashMenu, setActiveSlashMenu] = createSignal<ResolvedSlashMenu | null>(null);
  const [slashMenuSelectedIndex, setSlashMenuSelectedIndex] = createSignal(0);

  /** Returns the scroll viewport element managed by OverlayScrollbars. */
  function getScrollViewport(): HTMLElement | undefined {
    return osRef?.osInstance()?.elements().viewport;
  }

  function clearPendingViewportAction(): void {
    pendingViewportAction = null;
  }

  function clearViewportScrollListener(): void {
    viewportScrollCleanup?.();
    viewportScrollCleanup = null;
  }

  function clearViewportPersistRaf(): void {
    if (viewportPersistTimer !== null) {
      window.clearTimeout(viewportPersistTimer);
      viewportPersistTimer = null;
    }
  }

  function clearPendingScrollbarSyncRaf(): void {
    if (pendingScrollbarSyncRaf !== null) {
      cancelAnimationFrame(pendingScrollbarSyncRaf);
      pendingScrollbarSyncRaf = null;
    }
  }

  function clearHoverOpenTimer(): void {
    if (hoverOpenTimer !== null) {
      window.clearTimeout(hoverOpenTimer);
      hoverOpenTimer = null;
    }
  }

  function clearSlashMenuLayoutObserver(): void {
    slashMenuLayoutObserver?.disconnect();
    slashMenuLayoutObserver = null;
  }

  function runAfterLayoutSettles(action: () => void): void {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!disposed) action();
      });
    });
  }

  function saveCurrentViewportState(source: "live" | "cleanup" = "live"): void {
    const viewport = getScrollViewport();
    const scrollTop =
      source === "cleanup" ? lastKnownScrollTop : (viewport?.scrollTop ?? lastKnownScrollTop);
    const { anchor, head } = editor.view.state.selection;
    const snapshot = {
      scrollTop,
      selectionAnchor: anchor,
      selectionHead: head,
      wasFocused: containerRef?.contains(document.activeElement) ?? false,
    };
    lastKnownScrollTop = snapshot.scrollTop;
    saveViewportState(props.tabId, snapshot);
  }

  function syncScrollbarAxis(
    scrollbar: { scrollbar: HTMLElement; handle: HTMLElement },
    scrollOffset: number,
    scrollSize: number,
    clientSize: number,
  ): void {
    const maxScroll = Math.max(0, scrollSize - clientSize);
    const scrollPercent = maxScroll > 0 ? clampUnit(scrollOffset / maxScroll) : 0;
    const viewportPercent = scrollSize > 0 ? clampUnit(clientSize / scrollSize) : 1;

    scrollbar.scrollbar.style.setProperty("--os-scroll-percent", `${scrollPercent}`);
    scrollbar.scrollbar.style.setProperty("--os-viewport-percent", `${viewportPercent}`);
    scrollbar.scrollbar.style.setProperty("--os-scroll-direction", "0");
    scrollbar.handle.style.removeProperty("top");
    scrollbar.handle.style.removeProperty("left");
    scrollbar.handle.style.removeProperty("height");
    scrollbar.handle.style.removeProperty("width");
    scrollbar.handle.style.removeProperty("transform");
  }

  function syncScrollbarVisuals(instance = osRef?.osInstance()): void {
    if (!instance) return;

    const { viewport, scrollbarHorizontal, scrollbarVertical } = instance.elements();
    syncScrollbarAxis(
      scrollbarVertical,
      viewport.scrollTop,
      viewport.scrollHeight,
      viewport.clientHeight,
    );
    syncScrollbarAxis(
      scrollbarHorizontal,
      viewport.scrollLeft,
      viewport.scrollWidth,
      viewport.clientWidth,
    );
  }

  function scheduleScrollbarVisualSync(instance = osRef?.osInstance()): void {
    if (!instance || pendingScrollbarSyncRaf !== null) return;

    pendingScrollbarSyncRaf = requestAnimationFrame(() => {
      pendingScrollbarSyncRaf = null;
      syncScrollbarVisuals(instance);
    });
  }

  function scheduleViewportStatePersist(): void {
    if (!contentReady || disposed) {
      return;
    }

    clearViewportPersistRaf();
    viewportPersistTimer = window.setTimeout(() => {
      viewportPersistTimer = null;
      if (!contentReady || disposed) {
        return;
      }
      saveCurrentViewportState();
    }, 120);
  }

  function ensureViewportScrollListener(viewport = getScrollViewport()): void {
    if (!viewport) {
      return;
    }

    syncSlashMenuLayoutObserver();

    if (viewportScrollCleanup) {
      return;
    }

    lastKnownScrollTop = viewport.scrollTop;

    const handleScroll = () => {
      lastKnownScrollTop = viewport.scrollTop;
      scheduleViewportStatePersist();
      scheduleScrollbarVisualSync();
      requestAnimationFrame(() => refreshSlashMenu());
    };

    viewport.addEventListener("scroll", handleScroll, { passive: true });
    viewportScrollCleanup = () => {
      viewport.removeEventListener("scroll", handleScroll);
    };
  }

  function syncSlashMenuLayoutObserver(): void {
    clearSlashMenuLayoutObserver();

    if (isDiffMode || disposed || typeof ResizeObserver === "undefined") {
      return;
    }

    const elements = [containerRef, getScrollViewport()].filter(
      (value): value is HTMLElement => value instanceof HTMLElement,
    );
    if (elements.length === 0) {
      return;
    }

    const observer = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        if (!disposed) {
          refreshSlashMenu();
        }
      });
    });

    for (const element of new Set(elements)) {
      observer.observe(element);
    }

    slashMenuLayoutObserver = observer;
  }

  /**
   * Schedule an action that requires the OverlayScrollbars viewport to be
   * ready (e.g. scroll restore, search-result navigation).
   *
   * - If OS is already initialised the action runs after one rAF so the
   *   browser has a chance to compute layout.
   * - Otherwise it is queued and flushed from the `initialized` event.
   */
  function scheduleViewportAction(action: () => void): void {
    if (osReady) {
      runAfterLayoutSettles(action);
    } else {
      pendingViewportAction = action;
    }
  }

  /**
   * Apply viewport snapshot restore (selection + scroll position).
   * Must only be called when the OS viewport is ready.
   */
  function applyViewportRestore(): void {
    const snapshot = getViewportState(props.tabId);
    if (
      snapshot.scrollTop === 0 &&
      snapshot.selectionAnchor === 0 &&
      snapshot.selectionHead === 0 &&
      !snapshot.wasFocused
    ) {
      return;
    }

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

    const viewport = getScrollViewport();
    if (viewport) {
      viewport.scrollTop = snapshot.scrollTop;
      lastKnownScrollTop = viewport.scrollTop;
      scheduleScrollbarVisualSync();
    } else {
      lastKnownScrollTop = snapshot.scrollTop;
    }
  }

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

  function persistEditorRuntimeState(): void {
    if (!contentReady) return;

    saveCachedContent(props.tabId, editor.getDocJSON());
    saveCurrentViewportState("cleanup");

    if (checksum) {
      saveCachedChecksum(props.tabId, checksum);
    }
  }

  function syncSpellcheckSetting(spellCheckEnabled = settingsState.general.spellCheck): void {
    const enabled = !isDiffMode && spellCheckEnabled;

    requestAnimationFrame(() => {
      if (disposed) return;

      const editableSurface =
        containerRef?.querySelector<HTMLElement>('[contenteditable="true"]') ??
        containerRef?.querySelector<HTMLElement>(".ProseMirror");

      if (editableSurface) {
        editableSurface.spellcheck = enabled;
      }
    });
  }

  function hasActiveEditorSelection(): boolean {
    if (disposed || isDiffMode) return false;

    const selection = document.getSelection();
    if (!selection) return false;

    const { anchorNode, focusNode } = selection;
    return Boolean(
      (anchorNode && editor.view.dom.contains(anchorNode)) ||
      (focusNode && editor.view.dom.contains(focusNode)),
    );
  }

  function isEditorAnchor(value: EventTarget | null): value is HTMLAnchorElement {
    return value instanceof HTMLAnchorElement && editor.view.dom.contains(value);
  }

  function getClosestEditorAnchor(target: EventTarget | null): HTMLAnchorElement | null {
    if (!(target instanceof Element)) return null;
    const anchor = target.closest("a");
    return isEditorAnchor(anchor) ? anchor : null;
  }

  function resolveCurrentAnchorEditor(preferredAnchor?: HTMLAnchorElement | null): {
    editor: ResolvedAnchorEditor | null;
    origin: "hover" | "selection" | null;
  } {
    const hoverEditor =
      (preferredAnchor
        ? dispatchAnchorEditResolveFromAnchor(preferredAnchor, editor.view)
        : null) ??
      (hoveredAnchor ? dispatchAnchorEditResolveFromAnchor(hoveredAnchor, editor.view) : null);
    if (hoverEditor) {
      return { editor: hoverEditor, origin: "hover" };
    }

    return { editor: null, origin: null };
  }

  function setResolvedActiveAnchorEditor(preferredAnchor?: HTMLAnchorElement | null): void {
    const { editor: nextEditor, origin } = resolveCurrentAnchorEditor(preferredAnchor);
    setActiveAnchorEditor(nextEditor);
    setActiveAnchorEditorOrigin(origin);
  }

  function refreshActiveAnchorEditor(preferredAnchor?: HTMLAnchorElement | null): void {
    if (isDiffMode || disposed || anchorEditorPinned()) {
      return;
    }

    setResolvedActiveAnchorEditor(preferredAnchor);
  }

  function handleAnchorEditorPinnedChange(pinned: boolean): void {
    setAnchorEditorPinned(pinned);
    if (pinned || disposed) return;
    requestAnimationFrame(() => refreshActiveAnchorEditor());
  }

  function closeActiveAnchorEditor(options?: { focusEditor?: boolean }): void {
    const activeEditor = activeAnchorEditor();
    const origin = activeAnchorEditorOrigin();
    const closeResult = origin === "selection" ? activeEditor?.close?.(editor.view) : undefined;

    clearHoverOpenTimer();
    pendingHoverAnchor = null;
    hoveredAnchor = null;
    setAnchorEditorPinned(false);
    setActiveAnchorEditor(null);
    setActiveAnchorEditorOrigin(null);

    const focusEditor = options?.focusEditor ?? closeResult?.focusEditor ?? true;
    if (!focusEditor) {
      return;
    }

    requestAnimationFrame(() => {
      if (!disposed) {
        editor.view.focus();
      }
    });
  }

  function applyActiveAnchorEdit(values: AnchorEditValues): void {
    const activeEditor = activeAnchorEditor();
    if (!activeEditor) return;

    const result = activeEditor.apply(values, editor.view);
    if (result?.close) {
      closeActiveAnchorEditor({ focusEditor: result.focusEditor });
      return;
    }

    requestAnimationFrame(() => refreshActiveAnchorEditor());
  }

  function closeSlashMenu(): void {
    setActiveSlashMenu(null);
    setSlashMenuSelectedIndex(0);
  }

  function getVisibleSlashItems(): EditorSlashItem[] {
    const menu = activeSlashMenu();
    return menu ? filterEditorSlashItems(menu.query) : [];
  }

  function isSlashItemDisabled(item: EditorSlashItem): boolean {
    const isEnabled = item.isEnabled?.(readEditorSlashItemState(editor.view), editor);
    return isEnabled === false;
  }

  function refreshSlashMenu(): void {
    if (isDiffMode || disposed || !containerRef) {
      closeSlashMenu();
      return;
    }

    const nextMenu = resolveSlashMenu(editor, containerRef, getScrollViewport());
    const currentMenu = activeSlashMenu();

    if (!nextMenu) {
      closeSlashMenu();
      return;
    }

    setActiveSlashMenu(nextMenu);

    if (
      !currentMenu ||
      currentMenu.from !== nextMenu.from ||
      currentMenu.to !== nextMenu.to ||
      currentMenu.query !== nextMenu.query
    ) {
      setSlashMenuSelectedIndex(0);
      return;
    }

    const items = filterEditorSlashItems(nextMenu.query);
    if (items.length === 0) {
      setSlashMenuSelectedIndex(0);
      return;
    }

    setSlashMenuSelectedIndex((currentIndex) => Math.min(currentIndex, items.length - 1));
  }

  function applySlashItem(item: EditorSlashItem): void {
    const menu = activeSlashMenu();
    if (!menu || isSlashItemDisabled(item)) return;

    editor.view.dispatch(editor.view.state.tr.delete(menu.from, menu.to));
    closeSlashMenu();

    requestAnimationFrame(() => {
      void item.execute(editor);
      editor.view.focus();
      requestAnimationFrame(() => refreshSlashMenu());
    });
  }

  async function loadEditableDocument(): Promise<void> {
    // Read caches outside the reactive tracking context.
    // These reads happen synchronously before the first `await`, so
    // without `untrack` they become dependencies of the outer
    // `createEffect` — causing the effect to re-run (and the editor
    // to reset) whenever `saveCachedContent` / `saveCachedChecksum`
    // updates the store during save.
    const cachedContent = untrack(() => getCachedContent(props.tabId));
    const cachedChecksum = untrack(() => getCachedChecksum(props.tabId));
    if (cachedContent) {
      setEditorDocument(cachedContent);
      if (cachedChecksum) {
        checksum = cachedChecksum;
      }

      scheduleViewportAction(() => {
        const navigated = applyPendingSearchNavigation(editor, props.filePath, {
          clearOnMiss: true,
        });
        if (!navigated) {
          applyViewportRestore();
        }
      });

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

      scheduleViewportAction(() => {
        const navigated = applyPendingSearchNavigation(editor, props.filePath, {
          clearOnMiss: true,
        });
        if (!navigated) {
          applyViewportRestore();
        }
      });

      markTabDirty(props.tabId, false);
    } catch (error) {
      if (disposed) return;
      // oxlint-disable-next-line no-console -- intentional error logging
      console.error("Failed to load document:", error);
    }
  }

  async function loadDiffDocument(): Promise<void> {
    const diffEntry = untrack(() => getDiffEntry(props.filePath));
    if (!diffEntry || disposed) return;

    const content = untrack(() => getCachedContent(props.tabId)) ?? diffEntry.diffDoc;
    setEditorDocument(content);
    saveCachedContent(props.tabId, content);
    scheduleViewportAction(applyViewportRestore);
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

    saveCurrentViewportState();

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
        const docBeforeSave = editor.view.state.doc;

        try {
          const result = await writeFileWithChecksum(
            props.filePath,
            contentToWrite,
            currentChecksum,
          );

          if (result.status === "Written") {
            checksum = result.checksum;
            saveCachedChecksum(props.tabId, result.checksum);

            // Only mark clean and snapshot cache when the document
            // has not been edited while the async write was in flight.
            // ProseMirror doc objects are immutable — a reference
            // equality check is sufficient to detect changes.
            const docUnchanged = editor.view.state.doc === docBeforeSave;
            if (docUnchanged) {
              saveCachedContent(props.tabId, editor.getDocJSON());
              saveCurrentViewportState();
            }
            if (queuedSaveContent === null && docUnchanged) {
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
    scheduleViewportStatePersist();
  }

  function handleFocusOut(e: FocusEvent) {
    if (isDiffMode) return;
    const related = e.relatedTarget as Node | null;
    const container = e.currentTarget as HTMLElement;
    if (!related || !container.contains(related)) {
      setContextKey("editorTextFocus", false);
      closeSlashMenu();
    }
    scheduleViewportStatePersist();
  }

  onMount(() => {
    setContextKey("editorTextFocus", false);

    const handleSelectionChange = () => {
      requestAnimationFrame(() => {
        if (disposed) return;

        refreshSlashMenu();
        if (hasActiveEditorSelection()) {
          scheduleViewportStatePersist();
        }
      });
    };

    document.addEventListener("selectionchange", handleSelectionChange);
    onCleanup(() => {
      document.removeEventListener("selectionchange", handleSelectionChange);
    });
  });

  onCleanup(() => {
    clearPendingViewportAction();
    clearViewportPersistRaf();
    clearPendingScrollbarSyncRaf();
    clearHoverOpenTimer();
    clearSlashMenuLayoutObserver();
    clearViewportScrollListener();
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

  createEffect(() => {
    syncSpellcheckSetting(settingsState.general.spellCheck);
  });

  useDocChange(
    () => {
      if (isDiffMode || settingContent || disposed) return;
      markTabDirty(props.tabId, true);
      recordTyping();
      scheduleViewportStatePersist();
      requestAnimationFrame(() => refreshActiveAnchorEditor());
      requestAnimationFrame(() => refreshSlashMenu());
      if (settingsState.general.autoSave) {
        scheduleAutoSave();
      }
    },
    { editor },
  );

  // ── AI Edit Floating Input (Phase 5) ──

  const [showAiEditInput, setShowAiEditInput] = createSignal(false);

  function openAiEditInput(): void {
    setShowAiEditInput(true);
  }

  function closeAiEditInput(): void {
    setShowAiEditInput(false);
  }

  function handleEditorKeyDown(e: KeyboardEvent): void {
    const menu = activeSlashMenu();
    if (!menu) return;

    const items = getVisibleSlashItems();

    switch (e.key) {
      case "ArrowDown":
        if (items.length === 0) return;
        e.preventDefault();
        setSlashMenuSelectedIndex((current) => Math.min(current + 1, items.length - 1));
        return;
      case "ArrowUp":
        if (items.length === 0) return;
        e.preventDefault();
        setSlashMenuSelectedIndex((current) => Math.max(current - 1, 0));
        return;
      case "Enter":
      case "Tab": {
        const item = items[slashMenuSelectedIndex()];
        if (!item) return;
        e.preventDefault();
        applySlashItem(item);
        return;
      }
      case "Escape":
        e.preventDefault();
        closeSlashMenu();
        return;
    }
  }

  function handleEditorPointerMove(e: PointerEvent): void {
    if (anchorEditorPinned() || isLinkEditorElement(e.target)) {
      return;
    }

    const anchor = getClosestEditorAnchor(e.target);
    if (!anchor) {
      clearHoverOpenTimer();
      pendingHoverAnchor = null;
      hoveredAnchor = null;
      refreshActiveAnchorEditor();
      return;
    }

    if (hoveredAnchor === anchor) {
      if (activeAnchorEditorOrigin() === "hover") {
        refreshActiveAnchorEditor(anchor);
      }
      return;
    }

    if (pendingHoverAnchor === anchor) {
      return;
    }

    clearHoverOpenTimer();
    pendingHoverAnchor = anchor;

    if (hoveredAnchor) {
      hoveredAnchor = null;
      refreshActiveAnchorEditor();
    }

    hoverOpenTimer = window.setTimeout(() => {
      hoverOpenTimer = null;
      if (disposed || anchorEditorPinned() || pendingHoverAnchor !== anchor) {
        return;
      }

      pendingHoverAnchor = null;
      hoveredAnchor = anchor;
      const resolvedEditor = dispatchAnchorEditResolveFromAnchor(anchor, editor.view);
      setActiveAnchorEditor(resolvedEditor);
      setActiveAnchorEditorOrigin(resolvedEditor ? "hover" : null);
    }, HOVER_LINK_OPEN_DELAY_MS);
  }

  function handleEditorPointerLeave(): void {
    clearHoverOpenTimer();
    pendingHoverAnchor = null;
    hoveredAnchor = null;
    refreshActiveAnchorEditor();
  }

  useKeymap(
    () => ({
      "Mod-s": () => {
        if (isDiffMode) {
          return false;
        }

        void saveDocument();
        return true;
      },
      "Mod-Control-e": () => {
        if (isDiffMode) return false;
        openAiEditInput();
        return true;
      },
    }),
    { editor },
  );

  return (
    <ProseKit editor={editor}>
      <ScrollArea
        axis="both"
        class="size-full bg-bg-primary"
        data-editor-scroll=""
        ref={(r) => {
          osRef = r;
        }}
        events={{
          initialized: (instance: OverlayScrollbars) => {
            osReady = true;
            ensureViewportScrollListener(instance.elements().viewport);
            syncScrollbarVisuals(instance);
            if (pendingViewportAction) {
              const action = pendingViewportAction;
              clearPendingViewportAction();
              runAfterLayoutSettles(action);
            }
          },
          updated: (instance: OverlayScrollbars) => {
            syncScrollbarVisuals(instance);
          },
        }}
      >
        <Show
          when={!isDiffMode}
          fallback={
            <div
              class="w-full flex-1"
              ref={(el) => {
                containerRef = el;
                syncSpellcheckSetting();
              }}
              data-diff-editor=""
              onFocusIn={handleFocusIn}
              onFocusOut={handleFocusOut}
            >
              <div ref={editor.mount} />
            </div>
          }
        >
          <EditorContextMenu onRequestAiEdit={openAiEditInput}>
            <div
              class="relative w-full flex-1"
              ref={(el) => {
                containerRef = el;
                syncSpellcheckSetting();
                syncSlashMenuLayoutObserver();
                requestAnimationFrame(() => refreshActiveAnchorEditor());
                requestAnimationFrame(() => refreshSlashMenu());
              }}
              spellcheck={settingsState.general.spellCheck}
              onFocusIn={handleFocusIn}
              onFocusOut={handleFocusOut}
              onKeyDown={handleEditorKeyDown}
              onPointerMove={handleEditorPointerMove}
              onPointerLeave={handleEditorPointerLeave}
            >
              <div ref={editor.mount} />
              <Show when={showAiEditInput()}>
                <AiEditInput onClose={closeAiEditInput} />
              </Show>
              <Show when={activeSlashMenu()}>
                {(slashMenu) => (
                  <EditorSlashMenu
                    position={slashMenu().position}
                    items={getVisibleSlashItems()}
                    selectedIndex={slashMenuSelectedIndex()}
                    isItemDisabled={isSlashItemDisabled}
                    onHoverIndexChange={setSlashMenuSelectedIndex}
                    onSelect={applySlashItem}
                  />
                )}
              </Show>
              <Show when={activeAnchorEditor()}>
                {(activeEditor) => (
                  <AnchorEditInput
                    target={activeEditor().target}
                    autoFocus={false}
                    onApply={applyActiveAnchorEdit}
                    onPinnedChange={handleAnchorEditorPinnedChange}
                    onClose={closeActiveAnchorEditor}
                  />
                )}
              </Show>
              <BacklinksPanel filePath={props.filePath || null} />
            </div>
          </EditorContextMenu>
        </Show>
      </ScrollArea>
    </ProseKit>
  );
}
