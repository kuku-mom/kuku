import { batch, createEffect, createSignal, onCleanup, onMount, Show, untrack } from "solid-js";
import { union, type Editor } from "prosekit/core";
import { TextSelection } from "prosekit/pm/state";
import { ProseKit, useDocChange, useKeymap } from "prosekit/solid";

import { createKukuEditor, destroyEditor } from "~/components/editor/system/editor_engine";
import {
  focusOrCreateEditorEndParagraph,
  isEditorEndBlankPointerDown,
} from "~/components/editor/editor_end_affordance";
import { installWebKitCompositionWorkaround } from "~/components/editor/system/ime_composition_workaround";
import EditorContextMenu from "~/components/editor/editor_context_menu";
import AiEditInput from "~/components/editor/ai_edit_input";
import AnchorEditInput from "~/components/editor/anchor_edit_input";
import EditorSlashMenu from "~/components/editor/editor_slash_menu";
import EditorWikilinkMenu from "~/components/editor/editor_wikilink_menu";
import {
  computeSlashMenuPosition,
  type SlashMenuPosition,
} from "~/components/editor/slash_menu_position";
import ScrollArea, { type ScrollAreaHandle } from "~/components/scroll_area";
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
} from "~/plugins/builtin/core_editor/slash_items";
import { getMarkdownService } from "~/plugins/markdown_service";
import { setContextKey } from "~/plugins/context_keys";
import { defineDiffSchemaExtension, defineReadonly } from "~/plugins/builtin/diff_view";
import {
  consumeEditorFocusIfPendingForTab,
  filesState,
  getActiveTab,
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
import { revealPath, setSelectedPath, vaultState } from "~/stores/vault";
import {
  filterWikilinkSuggestions,
  flattenMarkdownFiles,
  type WikilinkSuggestItem,
} from "~/plugins/builtin/wikilink/wikilink_suggest";
import { applyPendingSearchNavigation } from "~/plugins/builtin/search/navigation";
import { registerEditorDocumentSession, type EditorSaveResult } from "~/stores/editor";
import { t } from "~/i18n";

import BacklinksPanel from "~/plugins/builtin/graph_view/backlinks_panel";

import "~/styles/editor.css";
import "~/plugins/builtin/diff_view/diff_view.css";

interface MarkdownEditorProps {
  tabId: string;
  filePath: string;
  mode?: "editable" | "diff";
}

const HOVER_LINK_OPEN_DELAY_MS = 1000;
const HOVER_LINK_CLOSE_DELAY_MS = 300;
const SLASH_MENU_WIDTH = 320;
const SLASH_MENU_MAX_HEIGHT = 400;
const SLASH_TRIGGER_PATTERN = /^(\s*)\/([^\s]*)$/;
const WIKILINK_TRIGGER_PATTERN = /\[\[([^[\]|]*)$/;
const WIKILINK_MENU_WIDTH = 320;
const WIKILINK_MENU_MAX_HEIGHT = 320;

interface ResolvedSlashMenu {
  from: number;
  to: number;
  query: string;
  position: SlashMenuPosition;
}

interface ResolvedWikilinkMenu {
  from: number;
  to: number;
  query: string;
  position: SlashMenuPosition;
}

interface SaveConflictState {
  expected: string;
  actual: string;
  resolving: "local" | "disk" | null;
  message: string | null;
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

function resolveWikilinkMenu(
  editor: Editor,
  containerEl: HTMLElement,
  viewportEl?: HTMLElement,
): ResolvedWikilinkMenu | null {
  const { state } = editor.view;
  const { selection } = state;
  if (!selection.empty) return null;

  const { $from } = selection;
  if (!$from.parent.isTextblock) return null;

  const textBefore = $from.parent.textBetween(0, $from.parentOffset, undefined, "\0");
  const match = WIKILINK_TRIGGER_PATTERN.exec(textBefore);
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
    menuWidth: WIKILINK_MENU_WIDTH,
    menuMaxHeight: WIKILINK_MENU_MAX_HEIGHT,
  });

  // match.index points to the first `[` of `[[`.
  const wikilinkStart = $from.start() + match.index;

  return {
    from: wikilinkStart,
    to: selection.from,
    query: match[1] ?? "",
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
  let saveInFlight: Promise<EditorSaveResult> | null = null;
  let inFlightSaveContent: string | null = null;
  let queuedSaveContent: string | null = null;
  let containerRef: HTMLDivElement | undefined;
  let scrollHandle: ScrollAreaHandle | undefined;
  let osReady = false;
  let pendingViewportAction: (() => void) | null = null;
  let viewportScrollCleanup: (() => void) | null = null;
  let viewportPersistTimer: number | null = null;
  let lastKnownScrollTop = 0;
  let hoverOpenTimer: number | null = null;
  let hoverCloseTimer: number | null = null;
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
  const [activeWikilinkMenu, setActiveWikilinkMenu] = createSignal<ResolvedWikilinkMenu | null>(
    null,
  );
  const [wikilinkMenuSelectedIndex, setWikilinkMenuSelectedIndex] = createSignal(0);
  const [saveConflict, setSaveConflict] = createSignal<SaveConflictState | null>(null);

  /** Returns the editor scroll viewport exposed by ScrollArea. */
  function getScrollViewport(): HTMLElement | undefined {
    return scrollHandle?.viewport;
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

  function clearHoverOpenTimer(): void {
    if (hoverOpenTimer !== null) {
      window.clearTimeout(hoverOpenTimer);
      hoverOpenTimer = null;
    }
  }

  function clearHoverCloseTimer(): void {
    if (hoverCloseTimer !== null) {
      window.clearTimeout(hoverCloseTimer);
      hoverCloseTimer = null;
    }
  }

  function scheduleHoverClose(): void {
    clearHoverCloseTimer();
    hoverCloseTimer = window.setTimeout(() => {
      hoverCloseTimer = null;
      if (disposed || anchorEditorPinned()) return;
      hoveredAnchor = null;
      refreshActiveAnchorEditor();
    }, HOVER_LINK_CLOSE_DELAY_MS);
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
      requestAnimationFrame(() => {
        refreshSlashMenu();
        refreshWikilinkMenu();
      });
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
          refreshWikilinkMenu();
        }
      });
    });

    for (const element of new Set(elements)) {
      observer.observe(element);
    }

    slashMenuLayoutObserver = observer;
  }

  /**
   * Schedule an action that requires the scroll viewport to be
   * ready (e.g. scroll restore, search-result navigation).
   *
   * - If the scroll viewport is already initialised the action runs after one rAF so the
   *   browser has a chance to compute layout.
   * - Otherwise it is queued and flushed from the viewport-ready hook.
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
   * Must only be called when the scroll viewport is ready.
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
      // `between` resolves to the nearest valid text position, so a stale
      // snapshot landing inside a non-textual block (e.g. an image node
      // that no longer accepts the original offset) still produces a
      // sane selection instead of throwing.
      const $anchor = tr.doc.resolve(anchor);
      const $head = tr.doc.resolve(head);
      tr.setSelection(TextSelection.between($anchor, $head));
      editor.view.dispatch(tr);
    } catch {
      // Snapshot fully unresolvable (doc shape changed too drastically) —
      // leave the default selection.
    }

    if (snapshot.wasFocused) {
      editor.view.focus();
    }

    const viewport = getScrollViewport();
    if (viewport) {
      viewport.scrollTop = snapshot.scrollTop;
      lastKnownScrollTop = viewport.scrollTop;
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
    clearHoverCloseTimer();
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

  function isSlashItemActive(item: EditorSlashItem): boolean {
    return item.isActive?.(readEditorSlashItemState(editor.view), editor) === true;
  }

  function isSlashItemDisabled(item: EditorSlashItem): boolean {
    const state = readEditorSlashItemState(editor.view);
    if (item.isActive?.(state, editor) === true) {
      // Already this block type: not a “broken” control — keep it usable (no-op/ toggle on select).
      return false;
    }
    return item.isEnabled?.(state, editor) === false;
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

  // ── Wikilink Suggest Menu ───────────────────────────────────────

  function closeWikilinkMenu(): void {
    setActiveWikilinkMenu(null);
    setWikilinkMenuSelectedIndex(0);
  }

  function getVisibleWikilinkItems(): WikilinkSuggestItem[] {
    const menu = activeWikilinkMenu();
    if (!menu) return [];
    const allItems = flattenMarkdownFiles(vaultState.files);
    return filterWikilinkSuggestions(allItems, menu.query, props.filePath);
  }

  function refreshWikilinkMenu(): void {
    if (isDiffMode || disposed || !containerRef) {
      closeWikilinkMenu();
      return;
    }

    const nextMenu = resolveWikilinkMenu(editor, containerRef, getScrollViewport());
    const currentMenu = activeWikilinkMenu();

    if (!nextMenu) {
      closeWikilinkMenu();
      return;
    }

    setActiveWikilinkMenu(nextMenu);

    if (
      !currentMenu ||
      currentMenu.from !== nextMenu.from ||
      currentMenu.to !== nextMenu.to ||
      currentMenu.query !== nextMenu.query
    ) {
      setWikilinkMenuSelectedIndex(0);
      return;
    }

    const items = getVisibleWikilinkItems();
    if (items.length === 0) {
      setWikilinkMenuSelectedIndex(0);
      return;
    }

    setWikilinkMenuSelectedIndex((current) => Math.min(current, items.length - 1));
  }

  function applyWikilinkItem(item: WikilinkSuggestItem): void {
    const menu = activeWikilinkMenu();
    if (!menu) return;

    const wikilinkType = editor.view.state.schema.nodes.wikilink;
    if (!wikilinkType) return;

    const node = wikilinkType.create({ target: item.path });
    const tr = editor.view.state.tr.replaceWith(menu.from, menu.to, node);
    editor.view.dispatch(tr);
    closeWikilinkMenu();

    requestAnimationFrame(() => {
      editor.view.focus();
    });
  }

  function tryFocusIfPendingForNewFile(): void {
    if (isDiffMode) return;
    if (!consumeEditorFocusIfPendingForTab(props.tabId)) return;
    requestAnimationFrame(() => {
      if (disposed) return;
      const active = getActiveTab();
      if (!active || active.id !== props.tabId) return;
      editor.view.focus();
    });
  }

  function isOwnTabDirty(): boolean {
    const tab = untrack(() => filesState.tabs.find((candidate) => candidate.id === props.tabId));
    return tab?.isDirty ?? false;
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
    const cachedDocumentIsDirty = cachedContent ? isOwnTabDirty() : false;
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
        if (cachedDocumentIsDirty) {
          tryFocusIfPendingForNewFile();
          return;
        }
      }
    }

    try {
      const result = await readFileWithChecksum(props.filePath);
      if (disposed) return;

      if (cachedContent && (cachedDocumentIsDirty || isOwnTabDirty())) {
        tryFocusIfPendingForNewFile();
        return;
      }

      checksum = result.checksum;
      saveCachedChecksum(props.tabId, result.checksum);

      if (cachedContent && cachedChecksum === result.checksum) {
        tryFocusIfPendingForNewFile();
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
      setSaveConflict(null);
      tryFocusIfPendingForNewFile();
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
    setSaveConflict(null);
  }

  function getSaveContent(): string | null {
    clearAutoSaveTimer();
    if (isDiffMode || !checksum) return null;

    const markdown = getMarkdownService();
    if (!markdown) return null;

    const json = editor.getDocJSON();
    return markdown.stringify(json);
  }

  async function saveDocument(): Promise<EditorSaveResult> {
    const content = getSaveContent();
    if (content === null) {
      return { status: "skipped", reason: isDiffMode ? "diff" : "not-ready" };
    }

    saveCurrentViewportState();

    if (content === queuedSaveContent || content === inFlightSaveContent) {
      if (saveInFlight) return saveInFlight;
      if (checksum) return { status: "saved", checksum, content };
      return { status: "skipped", reason: "missing-checksum" };
    }

    queuedSaveContent = content;
    if (saveInFlight) {
      return saveInFlight;
    }

    saveInFlight = (async () => {
      let lastResult: EditorSaveResult = { status: "skipped", reason: "not-ready" };
      while (queuedSaveContent !== null) {
        const contentToWrite = queuedSaveContent;
        queuedSaveContent = null;

        const currentChecksum = checksum;
        if (!currentChecksum) {
          return { status: "skipped", reason: "missing-checksum" };
        }

        inFlightSaveContent = contentToWrite;
        const docBeforeSave = editor.view.state.doc;

        try {
          const result = await writeFileWithChecksum(
            props.filePath,
            contentToWrite,
            currentChecksum,
          );

          // Disposed during the in-flight write: the file is already committed
          // on disk, but the editor / tab caches no longer matter. Bail out
          // before touching `editor.view` (destroyed in onCleanup) or writing
          // to a stale tab's cache.
          if (disposed) {
            queuedSaveContent = null;
            return { status: "skipped", reason: "disposed" };
          }

          if (result.status === "Written") {
            checksum = result.checksum;
            lastResult = { status: "saved", checksum: result.checksum, content: contentToWrite };
            saveCachedChecksum(props.tabId, result.checksum);
            setSaveConflict(null);

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
            setSaveConflict({
              expected: result.expected,
              actual: result.actual,
              resolving: null,
              message: null,
            });
            // oxlint-disable-next-line no-console -- intentional warning for save conflicts
            console.warn("Save conflict:", result);
            return {
              status: "conflict",
              expected: result.expected,
              actual: result.actual,
            };
          }
        } catch (error) {
          queuedSaveContent = null;
          // oxlint-disable-next-line no-console -- intentional error logging
          console.error("Failed to save document:", error);
          return {
            status: "error",
            message: error instanceof Error ? error.message : String(error),
          };
        } finally {
          inFlightSaveContent = null;
        }
      }
      return lastResult;
    })();

    try {
      return await saveInFlight;
    } finally {
      saveInFlight = null;
      inFlightSaveContent = null;
    }
  }

  async function reloadDocumentFromDisk(): Promise<EditorSaveResult> {
    if (isOwnTabDirty()) {
      return { status: "skipped", reason: "dirty" };
    }
    if (saveInFlight) {
      return { status: "skipped", reason: "saving" };
    }

    clearAutoSaveTimer();
    queuedSaveContent = null;
    saveCurrentViewportState();
    const previousChecksum = checksum;

    try {
      const result = await readFileWithChecksum(props.filePath);
      if (disposed) {
        return { status: "skipped", reason: "disposed" };
      }
      if (isOwnTabDirty()) {
        return { status: "skipped", reason: "dirty" };
      }

      const markdown = getMarkdownService();
      if (!markdown) {
        return { status: "skipped", reason: "not-ready" };
      }

      checksum = result.checksum;
      saveCachedChecksum(props.tabId, result.checksum);
      if (previousChecksum === result.checksum) {
        markTabDirty(props.tabId, false);
        setSaveConflict(null);
        return { status: "skipped", reason: "unchanged" };
      }

      const parsed = markdown.parse(result.content);
      setEditorDocument(parsed);
      saveCachedContent(props.tabId, parsed);
      scheduleViewportAction(applyViewportRestore);
      markTabDirty(props.tabId, false);
      setSaveConflict(null);
      return { status: "saved", checksum: result.checksum, content: result.content };
    } catch (error) {
      return {
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  onMount(() => {
    if (isDiffMode) return;
    const dispose = registerEditorDocumentSession({
      tabId: props.tabId,
      filePath: props.filePath,
      save: saveDocument,
      reloadFromDisk: reloadDocumentFromDisk,
      getChecksum: () => checksum,
    });
    onCleanup(dispose);
  });

  async function keepLocalChangesAfterConflict(): Promise<void> {
    const conflict = saveConflict();
    if (!conflict || conflict.resolving) return;

    const content = getSaveContent();
    if (content === null) {
      setSaveConflict({ ...conflict, message: t("editor.save_conflict.save_failed") });
      return;
    }

    setSaveConflict({ ...conflict, resolving: "local", message: null });
    saveCurrentViewportState();
    const docBeforeSave = editor.view.state.doc;

    try {
      const result = await writeFileWithChecksum(props.filePath, content, conflict.actual);
      if (disposed) return;

      if (result.status === "Written") {
        checksum = result.checksum;
        saveCachedChecksum(props.tabId, result.checksum);
        setSaveConflict(null);

        if (editor.view.state.doc === docBeforeSave) {
          saveCachedContent(props.tabId, editor.getDocJSON());
          saveCurrentViewportState();
          markTabDirty(props.tabId, false);
        }
        return;
      }

      setSaveConflict({
        expected: result.expected,
        actual: result.actual,
        resolving: null,
        message: t("editor.save_conflict.changed_again"),
      });
    } catch (error) {
      if (disposed) return;
      setSaveConflict({
        ...conflict,
        resolving: null,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function useDiskVersionAfterConflict(): Promise<void> {
    const conflict = saveConflict();
    if (!conflict || conflict.resolving) return;

    setSaveConflict({ ...conflict, resolving: "disk", message: null });
    clearAutoSaveTimer();
    queuedSaveContent = null;

    try {
      const result = await readFileWithChecksum(props.filePath);
      if (disposed) return;

      const markdown = getMarkdownService();
      if (!markdown) {
        setSaveConflict({
          ...conflict,
          resolving: null,
          message: t("editor.save_conflict.load_failed"),
        });
        return;
      }

      checksum = result.checksum;
      const parsed = markdown.parse(result.content);
      setEditorDocument(parsed);
      saveCachedChecksum(props.tabId, result.checksum);
      saveCachedContent(props.tabId, parsed);
      saveCurrentViewportState();
      markTabDirty(props.tabId, false);
      setSaveConflict(null);
    } catch (error) {
      if (disposed) return;
      setSaveConflict({
        ...conflict,
        resolving: null,
        message: error instanceof Error ? error.message : String(error),
      });
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
      closeWikilinkMenu();
    }
    scheduleViewportStatePersist();
  }

  onMount(() => {
    setContextKey("editorTextFocus", false);

    const handleSelectionChange = () => {
      requestAnimationFrame(() => {
        if (disposed) return;

        refreshSlashMenu();
        refreshWikilinkMenu();
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

  onMount(() => {
    // Keep this installed at the editor DOM boundary so it runs before
    // ProseMirror handles broken WebKit IME composition events.
    const cleanupCompositionWorkaround = installWebKitCompositionWorkaround(editor.view);
    onCleanup(cleanupCompositionWorkaround);
  });

  onCleanup(() => {
    clearPendingViewportAction();
    clearViewportPersistRaf();
    clearHoverOpenTimer();
    clearHoverCloseTimer();
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

    batch(() => {
      setSelectedPath(targetPath);
      revealPath(targetPath);
    });
  });

  // Initial document load. Using `onMount` (not `createEffect`) ensures this
  // runs exactly once after mount with stable ownership — a later rename
  // that updates `tab.filePath` reactively must not re-trigger a reload,
  // because `setEditorDocument(..., "start")` inside the loader would
  // reset the caret to the top of the document.
  onMount(() => {
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
      requestAnimationFrame(() => {
        refreshSlashMenu();
        refreshWikilinkMenu();
      });
      if (settingsState.general.autoSave) {
        if (!saveConflict()) {
          scheduleAutoSave();
        }
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

  function handleEditorMenuKey(key: string): boolean {
    // ── Slash menu keyboard handling ──
    const slashMenu = activeSlashMenu();
    if (slashMenu) {
      const items = getVisibleSlashItems();

      switch (key) {
        case "ArrowDown":
          if (items.length === 0) return false;
          setSlashMenuSelectedIndex((current) => Math.min(current + 1, items.length - 1));
          return true;
        case "ArrowUp":
          if (items.length === 0) return false;
          setSlashMenuSelectedIndex((current) => Math.max(current - 1, 0));
          return true;
        case "Enter":
        case "Tab": {
          const item = items[slashMenuSelectedIndex()];
          if (!item) return false;
          applySlashItem(item);
          return true;
        }
        case "Escape":
          closeSlashMenu();
          return true;
      }
      return false;
    }

    // ── Wikilink menu keyboard handling ──
    const wlMenu = activeWikilinkMenu();
    if (wlMenu) {
      const items = getVisibleWikilinkItems();

      switch (key) {
        case "ArrowDown":
          if (items.length === 0) return false;
          setWikilinkMenuSelectedIndex((current) => Math.min(current + 1, items.length - 1));
          return true;
        case "ArrowUp":
          if (items.length === 0) return false;
          setWikilinkMenuSelectedIndex((current) => Math.max(current - 1, 0));
          return true;
        case "Enter":
        case "Tab": {
          const item = items[wikilinkMenuSelectedIndex()];
          if (!item) return false;
          applyWikilinkItem(item);
          return true;
        }
        case "Escape":
          closeWikilinkMenu();
          return true;
      }
    }

    // ── Hover anchor editor dismiss ──
    if (key === "Escape" && activeAnchorEditor()) {
      clearHoverCloseTimer();
      closeActiveAnchorEditor();
      return true;
    }

    return false;
  }

  function handleEditorOverlayKeyDown(e: KeyboardEvent): void {
    if (isDiffMode || e.defaultPrevented || e.key !== "Escape") {
      return;
    }

    if (handleEditorMenuKey("Escape")) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  function handleEditorPointerDown(e: PointerEvent): void {
    if (isDiffMode || disposed) {
      return;
    }

    if (!isEditorEndBlankPointerDown(e, editor.view.dom)) {
      return;
    }

    e.preventDefault();
    e.stopPropagation();
    closeSlashMenu();
    closeWikilinkMenu();

    if (focusOrCreateEditorEndParagraph(editor.view)) {
      requestAnimationFrame(() => {
        refreshSlashMenu();
        refreshWikilinkMenu();
      });
    }
  }

  function handleEditorPointerMove(e: PointerEvent): void {
    if (anchorEditorPinned()) {
      return;
    }

    // Pointer is over the link-editor popup — cancel any pending close.
    if (isLinkEditorElement(e.target)) {
      clearHoverCloseTimer();
      return;
    }

    const anchor = getClosestEditorAnchor(e.target);
    if (!anchor) {
      clearHoverOpenTimer();
      pendingHoverAnchor = null;

      // If a hover editor is visible, debounce the close instead of killing it.
      if (activeAnchorEditor() && activeAnchorEditorOrigin() === "hover") {
        scheduleHoverClose();
      } else {
        hoveredAnchor = null;
        refreshActiveAnchorEditor();
      }
      return;
    }

    // Pointer returned to an anchor — cancel any pending close.
    clearHoverCloseTimer();

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

    // If a hover editor is visible, debounce instead of closing immediately.
    if (activeAnchorEditor() && activeAnchorEditorOrigin() === "hover") {
      scheduleHoverClose();
    } else {
      hoveredAnchor = null;
      refreshActiveAnchorEditor();
    }
  }

  function insertEditorIndent(): boolean {
    const spaces = " ".repeat(Math.max(1, settingsState.editor.tabSize));
    const { state } = editor.view;
    const { from, to } = state.selection;

    editor.view.dispatch(state.tr.insertText(spaces, from, to).scrollIntoView());
    return true;
  }

  function shouldDeferTabToStructuralKeymap(): boolean {
    const { $from } = editor.view.state.selection;

    for (let depth = $from.depth; depth >= 0; depth -= 1) {
      const nodeName = $from.node(depth).type.name;
      if (nodeName === "list" || nodeName === "tableCell" || nodeName === "tableHeader") {
        return true;
      }
    }

    return false;
  }

  useKeymap(
    () => ({
      ArrowDown: () => {
        if (isDiffMode) return false;
        return handleEditorMenuKey("ArrowDown");
      },
      ArrowUp: () => {
        if (isDiffMode) return false;
        return handleEditorMenuKey("ArrowUp");
      },
      Enter: () => {
        if (isDiffMode) return false;
        return handleEditorMenuKey("Enter");
      },
      Tab: () => {
        if (isDiffMode) return false;
        if (handleEditorMenuKey("Tab")) return true;
        if (shouldDeferTabToStructuralKeymap()) return false;
        return insertEditorIndent();
      },
      Escape: () => {
        if (isDiffMode) return false;
        return handleEditorMenuKey("Escape");
      },
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
        handleRef={(handle) => {
          scrollHandle = handle;
        }}
        onViewportReady={(handle) => {
          osReady = true;
          ensureViewportScrollListener(handle.viewport);
          if (pendingViewportAction) {
            const action = pendingViewportAction;
            clearPendingViewportAction();
            runAfterLayoutSettles(action);
          }
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
                requestAnimationFrame(() => {
                  refreshSlashMenu();
                  refreshWikilinkMenu();
                });
              }}
              spellcheck={settingsState.general.spellCheck}
              onFocusIn={handleFocusIn}
              onFocusOut={handleFocusOut}
              onKeyDown={handleEditorOverlayKeyDown}
              onPointerDown={handleEditorPointerDown}
              onPointerMove={handleEditorPointerMove}
              onPointerLeave={handleEditorPointerLeave}
            >
              <Show when={saveConflict()}>
                {(conflict) => (
                  <div class="sticky top-2 z-20 mx-4 mb-2 rounded-xs border border-border bg-[color-mix(in_srgb,var(--color-text-muted)_8%,var(--color-bg-elevated))] px-3 py-2 shadow-[0_2px_5px_rgba(0,0,0,0.08)]">
                    <div class="flex flex-wrap items-center justify-between gap-2">
                      <div class="min-w-0">
                        <div class="text-[0.8125rem] font-medium text-text-primary">
                          {t("editor.save_conflict.title")}
                        </div>
                        <div class="text-xs/snug text-text-muted">
                          {conflict().message ?? t("editor.save_conflict.description")}
                        </div>
                      </div>
                      <div class="flex shrink-0 items-center gap-1.5">
                        <button
                          type="button"
                          class="cursor-pointer rounded-xs border border-border bg-bg-secondary px-2.5 py-1 text-[0.75rem] text-text-secondary transition-colors hover:bg-ghost-hover disabled:cursor-wait disabled:text-text-disabled"
                          disabled={conflict().resolving !== null}
                          onClick={() => void useDiskVersionAfterConflict()}
                        >
                          {conflict().resolving === "disk"
                            ? t("editor.save_conflict.loading_disk")
                            : t("editor.save_conflict.use_disk")}
                        </button>
                        <button
                          type="button"
                          class="cursor-pointer rounded-xs border border-text-primary bg-text-primary px-2.5 py-1 text-[0.75rem] font-medium text-bg-primary transition-colors hover:border-text-secondary hover:bg-text-secondary disabled:cursor-wait disabled:border-border disabled:bg-bg-secondary disabled:text-text-muted"
                          disabled={conflict().resolving !== null}
                          onClick={() => void keepLocalChangesAfterConflict()}
                        >
                          {conflict().resolving === "local"
                            ? t("editor.save_conflict.saving_local")
                            : t("editor.save_conflict.keep_local")}
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </Show>
              <div ref={editor.mount} />
              <Show when={showAiEditInput()}>
                <AiEditInput onClose={closeAiEditInput} viewportEl={getScrollViewport()} />
              </Show>
              <Show when={activeSlashMenu()}>
                {(slashMenu) => (
                  <EditorSlashMenu
                    position={slashMenu().position}
                    items={getVisibleSlashItems()}
                    selectedIndex={slashMenuSelectedIndex()}
                    isItemDisabled={isSlashItemDisabled}
                    isItemActive={isSlashItemActive}
                    onHoverIndexChange={setSlashMenuSelectedIndex}
                    onSelect={applySlashItem}
                  />
                )}
              </Show>
              <Show when={activeWikilinkMenu()}>
                {(wlMenu) => (
                  <EditorWikilinkMenu
                    position={wlMenu().position}
                    items={getVisibleWikilinkItems()}
                    query={wlMenu().query}
                    selectedIndex={wikilinkMenuSelectedIndex()}
                    onHoverIndexChange={setWikilinkMenuSelectedIndex}
                    onSelect={applyWikilinkItem}
                  />
                )}
              </Show>
              <Show when={activeAnchorEditor()}>
                {(activeEditor) => (
                  <AnchorEditInput
                    target={activeEditor().target}
                    autoFocus={false}
                    viewportEl={getScrollViewport()}
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
