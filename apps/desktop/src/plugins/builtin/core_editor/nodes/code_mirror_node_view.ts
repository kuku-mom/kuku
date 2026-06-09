import { defaultKeymap } from "@codemirror/commands";
import {
  EditorState as CodeMirrorState,
  RangeSetBuilder,
  StateEffect,
  StateField,
  type Extension as CodeMirrorExtension,
  type Text as CodeMirrorText,
} from "@codemirror/state";
import {
  Decoration as CodeMirrorDecoration,
  type DecorationSet as CodeMirrorDecorationSet,
  drawSelection,
  EditorView as CodeMirrorView,
  keymap as codeMirrorKeymap,
  type KeyBinding,
  type ViewUpdate,
} from "@codemirror/view";
import highlighter, { type LanguageFn } from "highlight.js";
import type mermaid from "mermaid";
import type { MermaidConfig } from "mermaid";
import { defineNodeView, definePlugin, union, type Extension } from "prosekit/core";
import { exitCode } from "prosekit/pm/commands";
import { redo, undo } from "prosekit/pm/history";
import type { Node as ProseMirrorNode } from "prosekit/pm/model";
import { Plugin, Selection, TextSelection } from "prosekit/pm/state";
import type {
  Decoration as ProseMirrorDecoration,
  DecorationSource,
  EditorView as ProseMirrorView,
  NodeView,
} from "prosekit/pm/view";

import {
  normalizeCodeBlockLanguage,
  registerCodeBlockPreviewRenderer,
  resolveCodeBlockPreviewRenderer,
  type CodeBlockPreviewRenderContext,
  type CodeBlockPreviewRenderer,
} from "../code_block_preview_renderers";

type GetPos = () => number | undefined;
type ArrowDirection = "left" | "right" | "up" | "down";
type CodeBlockBehavior = "plain" | "renderable";
interface PreviewRenderOptions {
  preserveCurrent?: boolean;
}
interface ScrollAnchorSnapshot {
  element: HTMLElement | null;
  top: number;
  viewport: HTMLElement;
}
type Mermaid = typeof mermaid;

const MERMAID_FONT_PRELOAD_SAMPLE_TEXT =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789가나다라마바사아자차카타파하한글테스트あいうえおアイウエオ日本語";
const MERMAID_RENDER_FALLBACK_WIDTH = 1280;
const MERMAID_RENDER_LAYOUT_FRAME_LIMIT = 4;
const MERMAID_RENDER_MIN_WIDTH = 1280;

let mermaidLoader: Promise<Mermaid> | null = null;
let nextMermaidId = 0;
let pendingCodeBlockEntrySide: -1 | 1 | null = null;
const codeBlockFenceSyncDocuments = new WeakSet<Document>();
const codeBlockFenceSyncFrames = new WeakMap<Document, number>();
const codeBlockFenceRepairViews = new WeakSet<ProseMirrorView>();
const codeBlockViewsByEditor = new WeakMap<ProseMirrorView, Set<CodeMirrorCodeBlockView>>();
const codeBlockViewByRoot = new WeakMap<HTMLElement, CodeMirrorCodeBlockView>();
const codeBlockPreviewThemeObservers = new WeakMap<Document, MutationObserver>();
const codeBlockPreviewThemeSyncFrames = new WeakMap<Document, number>();
const setCodeHighlightLanguage = StateEffect.define<string>();

class CodeMirrorCodeBlockView implements NodeView {
  readonly dom: HTMLElement;
  private behavior: CodeBlockBehavior;
  private readonly cm: CodeMirrorView;
  private readonly editorChrome: HTMLElement;
  private editing: boolean;
  private readonly getPos: GetPos;
  private readonly languageInput: HTMLInputElement;
  private node: ProseMirrorNode;
  private readonly preview: HTMLElement;
  private readonly previewBody: HTMLElement;
  private activePreviewRenderer: CodeBlockPreviewRenderer | null = null;
  private previewHeightLockPreviousMinHeight = "";
  private previewHeightLockToken = 0;
  private previewRenderToken = 0;
  private updating = false;
  private readonly view: ProseMirrorView;

  constructor(node: ProseMirrorNode, view: ProseMirrorView, getPos: GetPos) {
    this.node = node;
    this.view = view;
    this.getPos = getPos;
    this.behavior = resolveCodeBlockBehavior(node);
    this.dom = document.createElement("div");
    this.dom.dataset.kukuCodeBlock = "";
    this.dom.dataset.kukuCodeMirrorBlock = "";
    this.editing = this.behavior === "plain";
    this.syncBehaviorDataset();
    ensureCodeBlockFenceSync(this.dom.ownerDocument);
    ensureCodeBlockPreviewThemeSync(this.dom.ownerDocument);
    registerCodeBlockView(this.view, this);

    this.editorChrome = document.createElement("div");
    this.editorChrome.dataset.kukuCodeBlockEditor = "";

    const openingFence = document.createElement("div");
    openingFence.dataset.kukuCodeBlockFenceLine = "";
    const openingMarker = document.createElement("span");
    openingMarker.dataset.kukuCodeBlockFenceChrome = "";
    openingMarker.dataset.kukuCodeBlockFenceMarker = "";
    openingMarker.contentEditable = "false";
    openingMarker.textContent = "```";
    this.languageInput = document.createElement("input");
    this.languageInput.type = "text";
    this.languageInput.autocomplete = "off";
    this.languageInput.autocapitalize = "off";
    this.languageInput.spellcheck = false;
    this.languageInput.tabIndex = -1;
    this.languageInput.ariaLabel = "Code language";
    this.languageInput.dataset.kukuCodeBlockFenceChrome = "";
    this.languageInput.dataset.kukuCodeBlockLanguageInput = "";
    this.languageInput.value = readLanguage(node);
    this.languageInput.addEventListener("input", () => this.forwardLanguageUpdate());
    this.languageInput.addEventListener("keydown", (event) => this.handleLanguageKeyDown(event));
    openingFence.append(openingMarker, this.languageInput);

    const editorHost = document.createElement("div");
    editorHost.dataset.kukuCodeMirrorHost = "";

    const closingFence = document.createElement("div");
    closingFence.dataset.kukuCodeBlockFenceLine = "";
    closingFence.dataset.kukuCodeBlockClosingFence = "";
    closingFence.contentEditable = "false";
    const closingMarker = document.createElement("span");
    closingMarker.dataset.kukuCodeBlockFenceChrome = "";
    closingMarker.dataset.kukuCodeBlockFenceMarker = "";
    closingMarker.textContent = "```";
    closingFence.append(closingMarker);

    this.preview = document.createElement("div");
    this.preview.dataset.kukuCodeBlockPreview = "";
    this.preview.contentEditable = "false";

    const previewToolbar = document.createElement("div");
    previewToolbar.dataset.kukuCodeBlockPreviewToolbar = "";
    const editButton = document.createElement("button");
    editButton.type = "button";
    editButton.ariaLabel = "Edit code";
    editButton.dataset.kukuCodeBlockEditButton = "";
    editButton.title = "Edit code";
    editButton.append(createEditIcon());
    editButton.addEventListener("click", () => this.enterEditMode(true));
    previewToolbar.append(editButton);

    this.previewBody = document.createElement("div");
    this.preview.addEventListener("dblclick", () => this.enterEditMode(true));
    this.preview.append(previewToolbar, this.previewBody);

    this.editorChrome.append(openingFence, editorHost, closingFence);
    this.dom.append(this.preview, this.editorChrome);
    this.dom.addEventListener("focusout", () => {
      window.setTimeout(() => {
        if (!this.dom.contains(this.dom.ownerDocument.activeElement)) {
          this.exitEditMode();
        }
      });
    });

    this.cm = new CodeMirrorView({
      doc: node.textContent,
      extensions: [
        codeMirrorKeymap.of([...this.codeMirrorKeymap(), ...defaultKeymap]),
        drawSelection(),
        defineCodeHighlightExtension(readLanguage(node)),
        defineEmbeddedFenceHiderExtension(readLanguage(node)),
        CodeMirrorView.lineWrapping,
        CodeMirrorView.updateListener.of((update) => this.forwardUpdate(update)),
        CodeMirrorState.tabSize.of(2),
      ],
      parent: editorHost,
    });
    this.syncRenderedMode();
    scheduleEmbeddedFenceContentRepair(this.view);
    scheduleCodeBlockViewRepaint(this);
  }

  destroy(): void {
    this.previewRenderToken += 1;
    unregisterCodeBlockView(this.view, this);
    this.cm.destroy();
  }

  ignoreMutation(): boolean {
    return true;
  }

  selectNode(): void {
    this.enterEditMode(true);
  }

  setSelection(anchor: number, head: number): void {
    this.enterEditMode(false);
    this.cm.focus();
    if (this.updating) return;

    const entrySide = pendingCodeBlockEntrySide;
    pendingCodeBlockEntrySide = null;
    const anchorOffset = this.toCodeMirrorSelectionOffset(anchor, entrySide);
    const headOffset = this.toCodeMirrorSelectionOffset(head, entrySide);
    this.updating = true;
    this.cm.dispatch({
      selection: {
        anchor: anchorOffset,
        head: headOffset,
      },
    });
    this.updating = false;
  }

  stopEvent(): boolean {
    return true;
  }

  update(
    node: ProseMirrorNode,
    _decorations: readonly ProseMirrorDecoration[],
    _innerDecorations: DecorationSource,
  ): boolean {
    if (node.type !== this.node.type) return false;
    const previousLanguage = readLanguage(this.node);
    this.node = node;
    this.behavior = resolveCodeBlockBehavior(node);
    this.syncBehaviorDataset();
    if (this.behavior === "plain") {
      this.editing = true;
    }
    this.syncLanguageInput();
    if (previousLanguage !== readLanguage(this.node)) {
      this.syncCodeHighlightLanguage();
    }
    this.syncRenderedMode();
    if (this.updating) return true;

    const nextText = node.textContent;
    const currentText = this.cm.state.doc.toString();
    if (nextText !== currentText) {
      let start = 0;
      let currentEnd = currentText.length;
      let nextEnd = nextText.length;
      while (start < currentEnd && currentText.charCodeAt(start) === nextText.charCodeAt(start)) {
        start += 1;
      }
      while (
        currentEnd > start &&
        nextEnd > start &&
        currentText.charCodeAt(currentEnd - 1) === nextText.charCodeAt(nextEnd - 1)
      ) {
        currentEnd -= 1;
        nextEnd -= 1;
      }
      this.updating = true;
      this.cm.dispatch({
        changes: {
          from: start,
          insert: nextText.slice(start, nextEnd),
          to: currentEnd,
        },
      });
      this.requestRepaint();
      this.updating = false;
    }
    if (!this.editing) {
      this.renderPreview();
    }
    return true;
  }

  private codeMirrorKeymap(): KeyBinding[] {
    return [
      { key: "ArrowUp", run: () => this.maybeEscape("line", -1) },
      { key: "ArrowLeft", run: () => this.maybeEscape("char", -1) },
      { key: "ArrowDown", run: () => this.maybeEscape("line", 1) },
      { key: "ArrowRight", run: () => this.maybeEscape("char", 1) },
      {
        key: "Ctrl-Enter",
        run: () => {
          if (!exitCode(this.view.state, this.view.dispatch)) return false;
          this.view.focus();
          return true;
        },
      },
      { key: "Ctrl-z", mac: "Cmd-z", run: () => undo(this.view.state, this.view.dispatch) },
      {
        key: "Shift-Ctrl-z",
        mac: "Shift-Cmd-z",
        run: () => redo(this.view.state, this.view.dispatch),
      },
      { key: "Ctrl-y", run: () => redo(this.view.state, this.view.dispatch) },
    ];
  }

  private forwardUpdate(update: ViewUpdate): void {
    if (this.updating || !this.cm.hasFocus) return;
    const pos = this.getPos();
    if (typeof pos !== "number") return;
    const code = update.state.doc.toString();

    const { main } = update.state.selection;
    const selectionFrom = pos + 1 + clamp(main.from, 0, code.length);
    const selectionTo = pos + 1 + clamp(main.to, 0, code.length);
    const currentSelection = this.view.state.selection;
    const codeChanged = code !== this.node.textContent;
    const selectionChanged =
      currentSelection.from !== selectionFrom || currentSelection.to !== selectionTo;

    if (!codeChanged && !selectionChanged) {
      return;
    }

    let tr = this.view.state.tr;
    if (codeChanged) {
      const from = pos + 1;
      const to = pos + 1 + this.node.content.size;
      tr = code ? tr.replaceWith(from, to, this.view.state.schema.text(code)) : tr.delete(from, to);
    }

    tr = tr.setSelection(TextSelection.create(tr.doc, selectionFrom, selectionTo));
    this.updating = true;
    this.view.dispatch(tr);
    this.updating = false;
  }

  private forwardLanguageUpdate(): void {
    if (this.updating) return;
    const pos = this.getPos();
    if (typeof pos !== "number") return;

    const language = normalizeLanguage(this.languageInput.value);
    if (language !== this.languageInput.value) {
      const cursor = this.languageInput.selectionStart ?? language.length;
      this.languageInput.value = language;
      this.languageInput.setSelectionRange(
        Math.min(cursor, language.length),
        Math.min(cursor, language.length),
      );
    }
    if (language === readLanguage(this.node)) return;

    const tr = this.view.state.tr.setNodeMarkup(pos, undefined, {
      ...this.node.attrs,
      language,
    });
    this.updating = true;
    this.view.dispatch(tr);
    this.updating = false;
  }

  private handleLanguageKeyDown(event: KeyboardEvent): void {
    if (event.key === "Enter" || event.key === "ArrowDown") {
      event.preventDefault();
      this.cm.focus();
      this.cm.dispatch({ selection: { anchor: 0 } });
    }
  }

  private maybeEscape(unit: "char" | "line", direction: -1 | 1): boolean {
    const { main } = this.cm.state.selection;
    if (!main.empty) return false;
    const range = unit === "line" ? this.cm.state.doc.lineAt(main.head) : main;
    if (direction < 0 ? range.from > 0 : range.to < this.cm.state.doc.length) return false;

    const pos = this.getPos();
    if (typeof pos !== "number") return false;
    const targetPos = pos + (direction < 0 ? 0 : this.node.nodeSize);
    const selection = Selection.near(this.view.state.doc.resolve(targetPos), direction);
    this.view.dispatch(this.view.state.tr.setSelection(selection).scrollIntoView());
    this.view.focus();
    return true;
  }

  private toCodeMirrorSelectionOffset(offset: number, entrySide: -1 | 1 | null): number {
    if (entrySide === 1 || offset <= 0) {
      return 0;
    }
    if (entrySide === -1 || offset >= this.node.content.size) {
      return this.cm.state.doc.length;
    }
    return clamp(offset, 0, this.cm.state.doc.length);
  }

  private enterEditMode(focus: boolean): void {
    this.editing = true;
    this.syncRenderedMode();
    if (focus) {
      this.cm.focus();
      this.cm.requestMeasure();
    }
  }

  private exitEditMode(): void {
    if (this.behavior === "plain") {
      this.editing = true;
      this.syncRenderedMode();
      return;
    }
    this.editing = false;
    this.syncRenderedMode();
  }

  private syncRenderedMode(): void {
    const showEditor = this.behavior === "plain" || this.editing;
    this.editorChrome.hidden = !showEditor;
    this.preview.hidden = showEditor;
    if (!showEditor) {
      this.renderPreview();
      this.setFenceChromeVisible(false);
    }
  }

  private syncBehaviorDataset(): void {
    this.dom.dataset.kukuCodeBlockBehavior = this.behavior;
  }

  private setFenceChromeVisible(visible: boolean): void {
    if (visible) {
      showCodeBlockFenceChrome(this.dom);
    } else {
      hideCodeBlockFenceChrome(this.dom);
    }
  }

  private syncCodeHighlightLanguage(): void {
    this.cm.dispatch({ effects: setCodeHighlightLanguage.of(readLanguage(this.node)) });
  }

  private syncLanguageInput(): void {
    const language = readLanguage(this.node);
    if (this.languageInput.value !== language) {
      this.languageInput.value = language;
    }
  }

  private renderPreview(): void {
    const renderer = this.resolvePreviewRenderer();
    if (!renderer) {
      this.renderCodePreview();
      return;
    }

    void this.renderCustomPreview(renderer);
  }

  private renderCodePreview(): void {
    const token = ++this.previewRenderToken;
    this.clearActivePreviewRenderer(null);
    this.previewBody.dataset.kukuCodeBlockRenderedCode = "";
    this.previewBody.textContent = "";

    const pre = document.createElement("pre");
    const code = document.createElement("code");
    const language = readLanguage(this.node).trim();
    if (language) {
      pre.dataset.language = language;
      code.className = `language-${language}`;
    }
    code.textContent = this.node.textContent;
    pre.append(code);
    this.previewBody.append(pre);

    if (!language) return;

    window.queueMicrotask(() => {
      if (token !== this.previewRenderToken) return;
      const highlightLanguage = resolveHighlightLanguage(language);
      if (!highlightLanguage) return;
      code.className = `hljs language-${language}`;
      try {
        code.innerHTML = highlighter.highlight(this.node.textContent, {
          ignoreIllegals: true,
          language: highlightLanguage,
        }).value;
      } catch {
        // Keep the already-rendered plain code preview if highlighting fails.
      }
    });
  }

  private async renderCustomPreview(
    renderer: CodeBlockPreviewRenderer,
    options: PreviewRenderOptions = {},
  ): Promise<void> {
    const token = ++this.previewRenderToken;
    this.clearActivePreviewRenderer(renderer);
    delete this.previewBody.dataset.kukuCodeBlockRenderedCode;

    try {
      await renderer.render({
        root: this.dom,
        previewBody: this.previewBody,
        editorRoot: this.view.dom,
        language: readLanguage(this.node),
        source: this.node.textContent,
        token,
        preserveCurrent: options.preserveCurrent === true,
        isCurrent: () =>
          token === this.previewRenderToken && this.resolvePreviewRenderer() === renderer,
        lockHeight: () => this.lockPreviewHeight(token),
      });
    } catch (error: unknown) {
      if (token !== this.previewRenderToken) return;
      renderer.clear?.(this.previewBody);
      this.previewBody.textContent =
        error instanceof Error ? error.message : "Unable to render code block preview";
    }
  }

  requestRepaint(): void {
    this.cm.requestMeasure();
    forceCodeBlockRepaint(this.dom);
  }

  clearSelection(): void {
    const { main } = this.cm.state.selection;
    if (main.empty) return;

    this.updating = true;
    this.cm.dispatch({ selection: { anchor: main.head } });
    this.updating = false;
  }

  refreshPreviewTheme(): Promise<void> | null {
    const renderer = this.resolvePreviewRenderer();
    if (renderer?.refreshOnThemeChange && this.behavior === "renderable" && !this.editing) {
      return this.renderCustomPreview(renderer, {
        preserveCurrent: renderer.preserveOnRefresh === true,
      });
    }
    return null;
  }

  private resolvePreviewRenderer(): CodeBlockPreviewRenderer | null {
    return resolveCodeBlockPreviewRenderer(readLanguage(this.node));
  }

  private clearActivePreviewRenderer(nextRenderer: CodeBlockPreviewRenderer | null): void {
    if (this.activePreviewRenderer && this.activePreviewRenderer !== nextRenderer) {
      this.activePreviewRenderer.clear?.(this.previewBody);
    }
    this.activePreviewRenderer = nextRenderer;
  }

  private lockPreviewHeight(token: number): (() => void) | null {
    const height = this.previewBody.offsetHeight;
    if (height <= 0) return null;

    if (this.previewHeightLockToken === 0) {
      this.previewHeightLockPreviousMinHeight = this.previewBody.style.minHeight;
    }
    this.previewHeightLockToken = token;
    this.previewBody.style.minHeight = `${height}px`;

    return () => this.releasePreviewHeight(token);
  }

  private releasePreviewHeight(token: number): void {
    if (this.previewHeightLockToken !== token) return;

    window.requestAnimationFrame(() => {
      if (this.previewHeightLockToken !== token) return;
      this.previewBody.style.minHeight = this.previewHeightLockPreviousMinHeight;
      this.previewHeightLockPreviousMinHeight = "";
      this.previewHeightLockToken = 0;
    });
  }
}

function scheduleEmbeddedFenceContentRepair(view: ProseMirrorView): void {
  if (codeBlockFenceRepairViews.has(view)) return;
  codeBlockFenceRepairViews.add(view);
  window.queueMicrotask(() => {
    codeBlockFenceRepairViews.delete(view);
    repairEmbeddedFenceContent(view);
  });
}

function repairEmbeddedFenceContent(view: ProseMirrorView): void {
  const repairs: { from: number; normalized: string; to: number }[] = [];
  view.state.doc.descendants((node, pos) => {
    if (node.type.name !== "codeBlock") return;
    const normalized = unwrapAccidentalEmbeddedFence(node.textContent, readLanguage(node));
    if (normalized === null) return;
    repairs.push({
      from: pos + 1,
      normalized,
      to: pos + 1 + node.content.size,
    });
  });

  if (repairs.length === 0) return;

  let tr = view.state.tr;
  for (const repair of repairs.sort((a, b) => b.from - a.from)) {
    tr = repair.normalized
      ? tr.replaceWith(repair.from, repair.to, view.state.schema.text(repair.normalized))
      : tr.delete(repair.from, repair.to);
  }
  tr.setMeta("addToHistory", false);
  view.dispatch(tr);
  scheduleCodeBlockViewRepaints(view);
}

function registerCodeBlockView(
  view: ProseMirrorView,
  codeBlockView: CodeMirrorCodeBlockView,
): void {
  codeBlockViewByRoot.set(codeBlockView.dom, codeBlockView);

  const codeBlockViews = codeBlockViewsByEditor.get(view);
  if (codeBlockViews) {
    codeBlockViews.add(codeBlockView);
    return;
  }
  codeBlockViewsByEditor.set(view, new Set([codeBlockView]));
}

function unregisterCodeBlockView(
  view: ProseMirrorView,
  codeBlockView: CodeMirrorCodeBlockView,
): void {
  codeBlockViewByRoot.delete(codeBlockView.dom);

  const codeBlockViews = codeBlockViewsByEditor.get(view);
  if (!codeBlockViews) return;
  codeBlockViews.delete(codeBlockView);
  if (codeBlockViews.size === 0) {
    codeBlockViewsByEditor.delete(view);
  }
}

function scheduleCodeBlockViewRepaints(view: ProseMirrorView): void {
  window.requestAnimationFrame(() => {
    for (const codeBlockView of codeBlockViewsByEditor.get(view) ?? []) {
      codeBlockView.requestRepaint();
    }
  });
}

function scheduleCodeBlockViewRepaint(codeBlockView: CodeMirrorCodeBlockView): void {
  window.requestAnimationFrame(() => codeBlockView.requestRepaint());
}

function forceCodeBlockRepaint(root: HTMLElement): void {
  const previousTransform = root.style.transform;
  root.style.transform = previousTransform ? `${previousTransform} translateZ(0)` : "translateZ(0)";
  void root.offsetHeight;
  window.requestAnimationFrame(() => {
    root.style.transform = previousTransform;
  });
}

function ensureCodeBlockPreviewThemeSync(doc: Document): void {
  if (codeBlockPreviewThemeObservers.has(doc)) return;

  const observer = new MutationObserver(() => scheduleCodeBlockPreviewThemeSync(doc));
  observer.observe(doc.documentElement, {
    attributeFilter: ["data-theme", "style"],
    attributes: true,
  });
  codeBlockPreviewThemeObservers.set(doc, observer);
}

function scheduleCodeBlockPreviewThemeSync(doc: Document): void {
  const win = doc.defaultView;
  if (!win || codeBlockPreviewThemeSyncFrames.has(doc)) return;

  const frame = win.requestAnimationFrame(() => {
    codeBlockPreviewThemeSyncFrames.delete(doc);
    syncCodeBlockPreviewTheme(doc);
  });
  codeBlockPreviewThemeSyncFrames.set(doc, frame);
}

function syncCodeBlockPreviewTheme(doc: Document): void {
  const anchor = captureScrollAnchor(doc);
  const renders: Promise<void>[] = [];

  for (const block of doc.querySelectorAll<HTMLElement>(
    '[data-kuku-code-mirror-block][data-kuku-code-block-behavior="renderable"]',
  )) {
    const render = codeBlockViewByRoot.get(block)?.refreshPreviewTheme();
    if (render) {
      renders.push(render);
    }
  }

  if (renders.length === 0) return;
  void Promise.allSettled(renders)
    .then(() => waitForNextAnimationFrame(doc))
    .then(() => restoreScrollAnchor(anchor));
}

function captureScrollAnchor(doc: Document): ScrollAnchorSnapshot | null {
  const viewport = doc.querySelector<HTMLElement>(
    "[data-editor-scroll] [data-scroll-area-viewport]",
  );
  if (!viewport) return null;

  const viewportTop = viewport.getBoundingClientRect().top;
  const anchor = findScrollAnchorElement(doc, viewportTop);
  return {
    element: anchor,
    top: anchor?.getBoundingClientRect().top ?? viewportTop,
    viewport,
  };
}

function findScrollAnchorElement(doc: Document, viewportTop: number): HTMLElement | null {
  const blocks = doc.querySelectorAll<HTMLElement>(".ProseMirror > *");
  for (const block of blocks) {
    const rect = block.getBoundingClientRect();
    if (rect.height > 0 && rect.bottom >= viewportTop) {
      return block;
    }
  }
  return null;
}

function restoreScrollAnchor(anchor: ScrollAnchorSnapshot | null): void {
  if (!anchor?.element?.isConnected) return;

  const nextTop = anchor.element.getBoundingClientRect().top;
  const delta = nextTop - anchor.top;
  if (Math.abs(delta) < 0.5) return;
  anchor.viewport.scrollTop += delta;
}

function unwrapAccidentalEmbeddedFence(source: string, language: string): string | null {
  if (!source.includes("```")) return null;

  const lines = source.split("\n");
  const firstLineIndex = lines.findIndex((line) => line.trim());
  const lastLineIndex = findLastNonEmptyLineIndex(lines);
  if (firstLineIndex === -1 || lastLineIndex === -1 || firstLineIndex >= lastLineIndex) {
    return null;
  }

  const firstLine = lines[firstLineIndex]?.trim() ?? "";
  const lastLine = lines[lastLineIndex]?.trim() ?? "";
  if (lastLine !== "```") return null;

  const openingFence = /^```([^\s`]*)\s*$/.exec(firstLine);
  if (!openingFence) return null;

  const embeddedLanguage = normalizeLanguage(openingFence[1] ?? "").toLowerCase();
  const blockLanguage = normalizeLanguage(language).toLowerCase();
  if (embeddedLanguage && blockLanguage && embeddedLanguage !== blockLanguage) return null;

  return lines.slice(firstLineIndex + 1, lastLineIndex).join("\n");
}

function findLastNonEmptyLineIndex(lines: readonly string[]): number {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index]?.trim()) return index;
  }
  return -1;
}

function ensureCodeBlockFenceSync(doc: Document): void {
  if (codeBlockFenceSyncDocuments.has(doc)) return;
  doc.addEventListener("pointerdown", syncCodeBlockFenceChromeFromPointer, true);
  doc.addEventListener("focusin", scheduleCodeBlockFenceChromeSync, true);
  doc.addEventListener("focusout", scheduleCodeBlockFenceChromeSync, true);
  doc.addEventListener("selectionchange", scheduleCodeBlockFenceChromeSync);
  codeBlockFenceSyncDocuments.add(doc);
}

function syncCodeBlockFenceChromeFromPointer(event: PointerEvent): void {
  const targetElement = eventTargetElement(event.target);
  if (!targetElement) return;

  const doc = targetElement.ownerDocument;
  const activeEditor = targetElement.closest<HTMLElement>("[data-kuku-code-block-editor]");
  const activeBlock = activeEditor?.closest<HTMLElement>("[data-kuku-code-mirror-block]") ?? null;
  syncCodeBlockFenceChromeFromActiveBlock(doc, activeBlock, false);

  const activeElement = doc.activeElement;
  if (
    !activeBlock &&
    activeElement instanceof HTMLElement &&
    activeElement.closest("[data-kuku-code-block-editor]")
  ) {
    activeElement.blur();
  }
}

function scheduleCodeBlockFenceChromeSync(event: Event): void {
  const doc = eventDocument(event);
  const win = doc?.defaultView;
  if (!doc || !win || codeBlockFenceSyncFrames.has(doc)) return;

  const frame = win.requestAnimationFrame(() => {
    codeBlockFenceSyncFrames.delete(doc);
    syncCodeBlockFenceChromeFromDocument(doc);
  });
  codeBlockFenceSyncFrames.set(doc, frame);
}

function syncCodeBlockFenceChromeFromDocument(doc: Document): void {
  const activeElement = doc.activeElement;
  const activeEditor =
    activeElement instanceof Element
      ? activeElement.closest<HTMLElement>("[data-kuku-code-block-editor]")
      : null;
  const activeBlock = activeEditor?.closest<HTMLElement>("[data-kuku-code-mirror-block]") ?? null;
  syncCodeBlockFenceChromeFromActiveBlock(doc, activeBlock, true);
}

function syncCodeBlockFenceChromeFromActiveBlock(
  doc: Document,
  activeBlock: HTMLElement | null,
  requireEditorActive: boolean,
): void {
  for (const block of doc.querySelectorAll<HTMLElement>("[data-kuku-code-mirror-block]")) {
    const show =
      block === activeBlock &&
      (requireEditorActive ? isCodeBlockEditorActive(block) : !isCodeBlockEditorHidden(block));
    if (show) {
      showCodeBlockFenceChrome(block);
    } else {
      hideCodeBlockFenceChrome(block);
      codeBlockViewByRoot.get(block)?.clearSelection();
    }
  }
}

function eventDocument(event: Event): Document | null {
  const target = event.target;
  if (target instanceof Document) return target;
  if (target instanceof Node) return target.ownerDocument;
  return null;
}

function eventTargetElement(target: EventTarget | null): Element | null {
  if (target instanceof Element) return target;
  if (target instanceof Node) return target.parentElement;
  return null;
}

function showCodeBlockFenceChrome(root: HTMLElement): void {
  root.dataset.kukuCodeBlockFenceVisible = "";
  const languageInput = root.querySelector<HTMLInputElement>(
    "[data-kuku-code-block-language-input]",
  );
  if (languageInput) {
    languageInput.tabIndex = 0;
  }
}

function hideCodeBlockFenceChrome(root: HTMLElement): void {
  delete root.dataset.kukuCodeBlockFenceVisible;
  const languageInput = root.querySelector<HTMLInputElement>(
    "[data-kuku-code-block-language-input]",
  );
  if (languageInput) {
    languageInput.tabIndex = -1;
  }
}

function isCodeBlockEditorHidden(root: HTMLElement): boolean {
  return (
    root.querySelector<HTMLElement>("[data-kuku-code-block-editor]")?.hasAttribute("hidden") ?? true
  );
}

function isCodeBlockEditorActive(root: HTMLElement): boolean {
  const activeElement = root.ownerDocument.activeElement;
  return (
    !isCodeBlockEditorHidden(root) &&
    ((activeElement instanceof Element && root.contains(activeElement)) ||
      root.matches(":focus-within") ||
      root.querySelector(".cm-focused") !== null)
  );
}

interface CodeBlockDebugSnapshot {
  index: number;
  language: string;
  behavior: string;
  fenceVisibleAttr: boolean;
  activeInside: boolean;
  activeElement: string;
  focusWithin: boolean;
  cmFocused: boolean;
  editorHidden: boolean;
  previewHidden: boolean;
  openingLineOpacity: string;
  openingMarkerOpacity: string;
  languageInputOpacity: string;
  closingLineOpacity: string;
  closingMarkerOpacity: string;
  rootTop: number;
  chromeText: string;
  cmText: string;
}

function installCodeBlockDebugHelper(targetWindow: Window & typeof globalThis): void {
  Object.assign(targetWindow, {
    __kukuCodeBlocks: {
      dump: () => dumpCodeBlockDebugState(targetWindow.document),
    },
  });
}

function dumpCodeBlockDebugState(doc: Document): CodeBlockDebugSnapshot[] {
  const activeElement = doc.activeElement;
  return [...doc.querySelectorAll<HTMLElement>("[data-kuku-code-mirror-block]")].map(
    (block, index): CodeBlockDebugSnapshot => {
      const fenceLines = [
        ...block.querySelectorAll<HTMLElement>("[data-kuku-code-block-fence-line]"),
      ];
      const markers = [
        ...block.querySelectorAll<HTMLElement>("[data-kuku-code-block-fence-marker]"),
      ];
      const editor = block.querySelector<HTMLElement>("[data-kuku-code-block-editor]");
      const preview = block.querySelector<HTMLElement>("[data-kuku-code-block-preview]");
      const languageInput = block.querySelector<HTMLInputElement>(
        "[data-kuku-code-block-language-input]",
      );
      const cmEditor = block.querySelector<HTMLElement>(".cm-editor");
      const cmContent = block.querySelector<HTMLElement>(".cm-content");
      const rootRect = block.getBoundingClientRect();

      return {
        index,
        language: languageInput?.value ?? "",
        behavior: block.dataset.kukuCodeBlockBehavior ?? "",
        fenceVisibleAttr: block.dataset.kukuCodeBlockFenceVisible !== undefined,
        activeInside: activeElement ? block.contains(activeElement) : false,
        activeElement: activeElement ? describeDebugElement(activeElement) : "",
        focusWithin: block.matches(":focus-within"),
        cmFocused: cmEditor?.classList.contains("cm-focused") ?? false,
        editorHidden: editor?.hasAttribute("hidden") ?? false,
        previewHidden: preview?.hasAttribute("hidden") ?? false,
        openingLineOpacity: readComputedOpacity(fenceLines[0]),
        openingMarkerOpacity: readComputedOpacity(markers[0]),
        languageInputOpacity: readComputedOpacity(languageInput),
        closingLineOpacity: readComputedOpacity(fenceLines.at(-1)),
        closingMarkerOpacity: readComputedOpacity(markers.at(-1)),
        rootTop: Math.round(rootRect.top),
        chromeText: fenceLines.map((line) => line.textContent ?? "").join(" / "),
        cmText: (cmContent?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 140),
      };
    },
  );
}

function readComputedOpacity(element: HTMLElement | null | undefined): string {
  return element
    ? (element.ownerDocument.defaultView?.getComputedStyle(element).opacity ?? "")
    : "";
}

function describeDebugElement(element: Element): string {
  const tag = element.tagName.toLowerCase();
  const className = typeof element.className === "string" ? element.className.trim() : "";
  if (!className) return tag;
  return `${tag}.${className.split(/\s+/).slice(0, 3).join(".")}`;
}

function defineCodeMirrorCodeBlockView(): Extension {
  return union(
    defineNodeView({
      name: "codeBlock",
      constructor: (node, view, getPos) =>
        new CodeMirrorCodeBlockView(node, view, getPos as GetPos),
    }),
    definePlugin(
      new Plugin({
        props: {
          handleKeyDown: (view, event) => {
            if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
              return false;
            }
            const direction = parseArrowDirection(event.key);
            return direction ? arrowHandler(direction)(view) : false;
          },
        },
      }),
    ),
  );
}

function parseArrowDirection(key: string): ArrowDirection | null {
  switch (key) {
    case "ArrowLeft":
      return "left";
    case "ArrowRight":
      return "right";
    case "ArrowUp":
      return "up";
    case "ArrowDown":
      return "down";
    default:
      return null;
  }
}

function arrowHandler(direction: ArrowDirection): (view: ProseMirrorView) => boolean {
  return (view) => {
    const { state } = view;
    if (!state.selection.empty || !view.endOfTextblock(direction)) return false;
    const side = direction === "left" || direction === "up" ? -1 : 1;
    const { $head } = state.selection;
    const target = side > 0 ? $head.after() : $head.before();
    const nextSelection = Selection.near(state.doc.resolve(target), side);
    if (nextSelection.$head.parent.type.name !== "codeBlock") return false;
    pendingCodeBlockEntrySide = side;
    view.dispatch(state.tr.setSelection(nextSelection).scrollIntoView());
    return true;
  };
}

function readLanguage(node: ProseMirrorNode): string {
  return typeof node.attrs.language === "string" ? node.attrs.language : "";
}

function resolveCodeBlockBehavior(node: ProseMirrorNode): CodeBlockBehavior {
  return resolveCodeBlockPreviewRenderer(readLanguage(node)) ? "renderable" : "plain";
}

function normalizeLanguage(value: string): string {
  return value.replace(/[\s`]+/g, "");
}

function registerMermaidHighlightLanguage(): void {
  if (!highlighter.getLanguage("mermaid")) {
    highlighter.registerLanguage("mermaid", defineMermaidHighlightLanguage);
  }
  if (!highlighter.getLanguage("mmd")) {
    highlighter.registerAliases(["mmd"], { languageName: "mermaid" });
  }
}

const defineMermaidHighlightLanguage: LanguageFn = (hljs) => ({
  name: "Mermaid",
  case_insensitive: false,
  keywords: {
    keyword:
      "accDescr accTitle activate alt and architecture-beta as autonumber block-beta break callback call class classDef classDiagram classDiagram-v2 click critical dateFormat deactivate destroy direction end erDiagram excludes flowchart gantt gitGraph graph includes journey linkStyle loop mindmap note opt over packet par participant pie quadrantChart rect requirementDiagram sankey-beta section sequenceDiagram stateDiagram stateDiagram-v2 style subgraph title timeline xychart-beta",
    built_in: "BT LR RL TB TD",
    literal: "false true",
  },
  contains: [
    {
      className: "comment",
      begin: /%%/,
      end: /$/,
    },
    hljs.QUOTE_STRING_MODE,
    hljs.APOS_STRING_MODE,
    {
      className: "string",
      begin: /\|/,
      end: /\|/,
    },
    {
      className: "string",
      begin: /[[({]/,
      end: /[\])}]/,
      relevance: 0,
    },
    {
      className: "operator",
      begin: /(?:<-+>?|[-.=ox]+>|<[-.=ox]+|[-.=ox]{2,}|:::+)/,
      relevance: 0,
    },
    {
      className: "attribute",
      begin: /\b[A-Za-z][\w-]*(?=\s*:)/,
    },
    {
      className: "title",
      begin: /\b[A-Za-z_][\w-]*(?=\s*[[({])/,
    },
    hljs.NUMBER_MODE,
  ],
});

const mermaidCodeBlockPreviewRenderer: CodeBlockPreviewRenderer = {
  id: "mermaid",
  matches: (language) => {
    const normalized = normalizeCodeBlockLanguage(language);
    return normalized === "mermaid" || normalized === "mmd";
  },
  render: renderMermaidPreview,
  clear: clearMermaidPreviewState,
  preserveOnRefresh: true,
  refreshOnThemeChange: true,
};

async function renderMermaidPreview(ctx: CodeBlockPreviewRenderContext): Promise<void> {
  const source = ctx.source.trim();
  const preserveCurrent =
    ctx.preserveCurrent === true &&
    ctx.previewBody.dataset.kukuCodeBlockMermaidSvg !== undefined;
  const releaseHeightLock = preserveCurrent ? ctx.lockHeight() : null;

  if (!preserveCurrent) {
    clearMermaidPreviewState(ctx.previewBody);
    ctx.previewBody.dataset.kukuCodeBlockMermaidPlaceholder = "";
    ctx.previewBody.textContent = "";
  }

  if (!source) {
    if (!preserveCurrent) {
      ctx.previewBody.textContent = "Empty Mermaid diagram";
    }
    releaseHeightLock?.();
    return;
  }

  let renderContainer: HTMLElement | null = null;
  try {
    const renderWidth = await waitForMermaidRenderWidth(ctx.previewBody, ctx.editorRoot);
    if (!ctx.isCurrent()) return;

    const config = buildMermaidConfig(ctx.root);
    renderContainer = createMermaidRenderContainer(ctx.previewBody, renderWidth);
    const mermaid = await loadMermaid();
    await waitForMermaidFonts(ctx.root, source, config);
    if (!ctx.isCurrent()) return;

    mermaid.initialize(config);
    const result = await mermaid.render(
      `kuku-editor-mermaid-${nextMermaidId++}`,
      source,
      renderContainer,
    );

    if (!ctx.isCurrent()) return;
    ctx.previewBody.removeAttribute("data-kuku-code-block-mermaid-placeholder");
    delete ctx.previewBody.dataset.kukuCodeBlockMermaidError;
    ctx.previewBody.dataset.kukuCodeBlockMermaidSvg = "";
    ctx.previewBody.innerHTML = result.svg;
  } catch (error: unknown) {
    if (!ctx.isCurrent()) return;
    if (preserveCurrent && ctx.previewBody.dataset.kukuCodeBlockMermaidSvg !== undefined) {
      return;
    }
    ctx.previewBody.removeAttribute("data-kuku-code-block-mermaid-placeholder");
    delete ctx.previewBody.dataset.kukuCodeBlockMermaidSvg;
    ctx.previewBody.dataset.kukuCodeBlockMermaidError = "";
    ctx.previewBody.textContent =
      error instanceof Error ? error.message : "Unable to render diagram";
  } finally {
    renderContainer?.remove();
    releaseHeightLock?.();
  }
}

function clearMermaidPreviewState(previewBody: HTMLElement): void {
  delete previewBody.dataset.kukuCodeBlockMermaidSvg;
  delete previewBody.dataset.kukuCodeBlockMermaidError;
  delete previewBody.dataset.kukuCodeBlockMermaidPlaceholder;
}

registerMermaidHighlightLanguage();
registerCodeBlockPreviewRenderer(mermaidCodeBlockPreviewRenderer);

interface CodeHighlightState {
  decorations: CodeMirrorDecorationSet;
  language: string;
}

interface EmbeddedFenceHiderState {
  decorations: CodeMirrorDecorationSet;
  language: string;
}

function defineCodeHighlightExtension(initialLanguage: string): CodeMirrorExtension {
  return StateField.define<CodeHighlightState>({
    create(state) {
      return {
        decorations: buildCodeHighlightDecorations(state.doc.toString(), initialLanguage),
        language: initialLanguage,
      };
    },
    update(value, transaction) {
      let language = value.language;
      for (const effect of transaction.effects) {
        if (effect.is(setCodeHighlightLanguage)) {
          language = effect.value;
        }
      }

      if (language === value.language && !transaction.docChanged) {
        return value;
      }

      return {
        decorations: buildCodeHighlightDecorations(transaction.state.doc.toString(), language),
        language,
      };
    },
    provide: (field) => CodeMirrorView.decorations.from(field, (value) => value.decorations),
  });
}

function defineEmbeddedFenceHiderExtension(initialLanguage: string): CodeMirrorExtension {
  return StateField.define<EmbeddedFenceHiderState>({
    create(state) {
      return {
        decorations: buildEmbeddedFenceHiderDecorations(state.doc, initialLanguage),
        language: initialLanguage,
      };
    },
    update(value, transaction) {
      let language = value.language;
      for (const effect of transaction.effects) {
        if (effect.is(setCodeHighlightLanguage)) {
          language = effect.value;
        }
      }

      if (language === value.language && !transaction.docChanged) {
        return value;
      }

      return {
        decorations: buildEmbeddedFenceHiderDecorations(transaction.state.doc, language),
        language,
      };
    },
    provide: (field) => CodeMirrorView.decorations.from(field, (value) => value.decorations),
  });
}

function buildEmbeddedFenceHiderDecorations(
  doc: CodeMirrorText,
  language: string,
): CodeMirrorDecorationSet {
  const ranges = findEmbeddedFenceLineRanges(doc, language);
  if (ranges.length === 0) return CodeMirrorDecoration.none;

  const hiddenLine = CodeMirrorDecoration.replace({ block: true });
  const builder = new RangeSetBuilder<CodeMirrorDecoration>();
  for (const range of ranges) {
    builder.add(range.from, range.to, hiddenLine);
  }
  return builder.finish();
}

function findEmbeddedFenceLineRanges(
  doc: CodeMirrorText,
  language: string,
): { from: number; to: number }[] {
  if (doc.lines < 2) return [];

  const firstLine = firstNonEmptyCodeMirrorLine(doc);
  const lastLine = lastNonEmptyCodeMirrorLine(doc);
  if (!firstLine || !lastLine || firstLine.number >= lastLine.number) return [];

  const openingFence = /^```([^\s`]*)\s*$/.exec(firstLine.text.trim());
  if (!openingFence || lastLine.text.trim() !== "```") return [];

  const embeddedLanguage = normalizeLanguage(openingFence[1] ?? "").toLowerCase();
  const blockLanguage = normalizeLanguage(language).toLowerCase();
  if (embeddedLanguage && blockLanguage && embeddedLanguage !== blockLanguage) return [];

  return [
    { from: firstLine.from, to: lineEndIncludingBreak(doc, firstLine.number) },
    { from: lineStartIncludingPreviousBreak(doc, lastLine.number), to: doc.length },
  ];
}

function firstNonEmptyCodeMirrorLine(
  doc: CodeMirrorText,
): { from: number; number: number; text: string } | null {
  for (let lineNumber = 1; lineNumber <= doc.lines; lineNumber += 1) {
    const line = doc.line(lineNumber);
    if (line.text.trim()) return { from: line.from, number: line.number, text: line.text };
  }
  return null;
}

function lastNonEmptyCodeMirrorLine(doc: CodeMirrorText): { number: number; text: string } | null {
  for (let lineNumber = doc.lines; lineNumber >= 1; lineNumber -= 1) {
    const line = doc.line(lineNumber);
    if (line.text.trim()) return { number: line.number, text: line.text };
  }
  return null;
}

function lineEndIncludingBreak(doc: CodeMirrorText, lineNumber: number): number {
  const line = doc.line(lineNumber);
  return line.to < doc.length ? line.to + 1 : line.to;
}

function lineStartIncludingPreviousBreak(doc: CodeMirrorText, lineNumber: number): number {
  if (lineNumber <= 1) return 0;
  return doc.line(lineNumber - 1).to;
}

function buildCodeHighlightDecorations(source: string, language: string): CodeMirrorDecorationSet {
  const highlightLanguage = resolveHighlightLanguage(language);
  if (!source || !highlightLanguage) return CodeMirrorDecoration.none;

  const template = document.createElement("template");
  try {
    template.innerHTML = highlighter.highlight(source, {
      ignoreIllegals: true,
      language: highlightLanguage,
    }).value;
  } catch {
    return CodeMirrorDecoration.none;
  }

  const builder = new RangeSetBuilder<CodeMirrorDecoration>();
  let offset = 0;
  appendHighlightDecorations(
    template.content,
    [],
    builder,
    () => offset,
    (next) => {
      offset = next;
    },
  );
  return builder.finish();
}

function appendHighlightDecorations(
  node: Node,
  inheritedClasses: string[],
  builder: RangeSetBuilder<CodeMirrorDecoration>,
  readOffset: () => number,
  writeOffset: (offset: number) => void,
): void {
  if (node.nodeType === Node.TEXT_NODE) {
    const value = node.textContent ?? "";
    const from = readOffset();
    const to = from + value.length;
    if (to > from && inheritedClasses.length > 0) {
      builder.add(
        from,
        to,
        CodeMirrorDecoration.mark({ class: [...new Set(inheritedClasses)].join(" ") }),
      );
    }
    writeOffset(to);
    return;
  }

  const nextClasses =
    node instanceof HTMLElement ? [...inheritedClasses, ...node.classList] : inheritedClasses;
  for (const child of node.childNodes) {
    appendHighlightDecorations(child, nextClasses, builder, readOffset, writeOffset);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function buildMermaidConfig(root: HTMLElement): MermaidConfig {
  const readToken = createCssTokenReader(root);
  const darkMode = root.ownerDocument.documentElement.dataset.theme !== "light";
  const fontFamily = normalizeCssTokenValue(
    readToken(
      "--font-editor",
      '"Emoji", "Goorm Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    ),
  );
  const fontSize = readComputedPixelValue(root, "fontSize", 16);
  const stateFontSize = Math.max(16, Math.round(fontSize * 1.5));
  const stateLabelHeight = Math.ceil(stateFontSize * 0.7);
  const background = readToken("--color-mermaid-bg", "#1e1e1e");
  const surface = readToken("--color-mermaid-surface", "#262626");
  const surfaceAlt = readToken("--color-mermaid-surface-alt", "#303030");
  const border = readToken("--color-mermaid-border", "#5a5a5a");
  const borderStrong = readToken("--color-mermaid-border-strong", "#8a8a8a");
  const text = readToken("--color-mermaid-text", "#d4d4d4");
  const mutedText = readToken("--color-mermaid-text-muted", "#969696");
  const line = readToken("--color-mermaid-line", "#8a8a8a");
  const accent = readToken("--color-mermaid-accent", "#d4d4d4");
  const accentAlt = readToken("--color-mermaid-accent-alt", "#c0c0c0");
  const success = readToken("--color-mermaid-success", "#6bc46d");
  const warning = readToken("--color-mermaid-warning", "#e5a644");
  const danger = readToken("--color-mermaid-danger", "#e55561");
  const info = readToken("--color-mermaid-info", "#8a8a8a");
  const noteBackground = readToken("--color-mermaid-note-bg", surfaceAlt);
  const clusterBackground = readToken("--color-mermaid-cluster-bg", surface);
  const edgeLabelBackground = readToken("--color-mermaid-edge-label-bg", background);
  const sectionBackground = readToken("--color-mermaid-section-bg", surface);
  const taskBackground = readToken("--color-mermaid-task-bg", surfaceAlt);
  const taskDoneBackground = readToken("--color-mermaid-task-done-bg", success);
  const taskActiveBackground = readToken("--color-mermaid-task-active-bg", warning);
  const taskCriticalBackground = readToken("--color-mermaid-task-critical-bg", danger);
  const themeColorLimit = 12;
  const radius = parsePositiveCssNumber(readToken("--radius-sm", "2px"), 2);
  const strokeWidth = 1.5;
  const tagFontSize = `${Math.max(10, Math.round(fontSize * 0.625))}px`;
  const bodyFontSize = `${fontSize}px`;
  const pieTitleFontSize = `${Math.max(20, Math.round(fontSize * 1.5))}px`;
  const pieTextFontSize = `${Math.max(13, Math.round(fontSize))}px`;
  const journeyFills = [
    readToken("--color-mermaid-journey-fill-1", surfaceAlt),
    readToken("--color-mermaid-journey-fill-2", surface),
    readToken("--color-mermaid-journey-fill-3", taskDoneBackground),
    readToken("--color-mermaid-journey-fill-4", taskActiveBackground),
    readToken("--color-mermaid-journey-fill-5", taskCriticalBackground),
    readToken("--color-mermaid-journey-fill-6", noteBackground),
  ];
  const journeyActors = [success, warning, info, accentAlt, danger, mutedText];
  const scale = [
    readToken("--color-mermaid-scale-1", accent),
    readToken("--color-mermaid-scale-2", mutedText),
    readToken("--color-mermaid-scale-3", success),
    readToken("--color-mermaid-scale-4", warning),
    readToken("--color-mermaid-scale-5", danger),
    readToken("--color-mermaid-scale-6", info),
  ];
  const diagramScale = [
    readToken("--color-mermaid-diagram-scale-1", surfaceAlt),
    readToken("--color-mermaid-diagram-scale-2", darkMode ? "#3a3a3a" : "#d0d0d0"),
    readToken("--color-mermaid-diagram-scale-3", taskDoneBackground),
    readToken("--color-mermaid-diagram-scale-4", taskActiveBackground),
    readToken("--color-mermaid-diagram-scale-5", taskCriticalBackground),
    readToken("--color-mermaid-diagram-scale-6", noteBackground),
  ];
  const xyChartScale = darkMode
    ? scale
    : [
        readToken("--color-mermaid-xy-scale-1", "#b8b8b8"),
        readToken("--color-mermaid-xy-scale-2", "#6f6f6f"),
        readToken("--color-mermaid-xy-scale-3", "#9a9a9a"),
        readToken("--color-mermaid-xy-scale-4", "#c8c8c8"),
        readToken("--color-mermaid-xy-scale-5", "#858585"),
        readToken("--color-mermaid-xy-scale-6", "#adadad"),
      ];
  const diagramScaleContrast = repeatPalette([line], themeColorLimit);
  const diagramScalePeer = repeatPalette([borderStrong, border, line, accentAlt], themeColorLimit);
  const diagramScaleLabels = repeatPalette([text], themeColorLimit);
  const surfacePalette = [surface, surfaceAlt, clusterBackground, noteBackground, taskBackground];
  const surfacePeerPalette = [borderStrong, border, line, mutedText, accentAlt];
  const gitPalette = repeatPalette(
    [accent, success, warning, danger, info, accentAlt, mutedText, borderStrong],
    8,
  );
  const gitContrast = repeatPalette([background], 8);
  const branchLabelPalette = repeatPalette([darkMode ? background : edgeLabelBackground], 8);

  return {
    fontFamily,
    fontSize,
    journey: {
      actorColours: journeyActors,
      sectionColours: [text],
      sectionFills: journeyFills,
      taskFontFamily: fontFamily,
      taskFontSize: Math.max(12, Math.round(fontSize * 0.875)),
      titleColor: text,
      titleFontFamily: fontFamily,
      titleFontSize: `${Math.round(fontSize * 2)}px`,
    },
    securityLevel: "strict",
    startOnLoad: false,
    state: {
      fontSize: stateFontSize,
      fontSizeFactor: Math.max(5.02, fontSize * 0.9),
      labelHeight: stateLabelHeight,
      textHeight: Math.ceil(stateFontSize * 0.65),
    },
    theme: "base",
    themeVariables: {
      THEME_COLOR_LIMIT: themeColorLimit,
      activationBkgColor: surfaceAlt,
      activationBorderColor: borderStrong,
      actorBkg: surface,
      actorBorder: borderStrong,
      actorLineColor: line,
      actorTextColor: text,
      activeTaskBkgColor: taskActiveBackground,
      activeTaskBorderColor: warning,
      altBackground: surfaceAlt,
      altSectionBkgColor: surfaceAlt,
      archEdgeArrowColor: line,
      archEdgeColor: line,
      archEdgeWidth: "3",
      archGroupBorderColor: borderStrong,
      archGroupBorderWidth: "2px",
      arrowheadColor: line,
      attributeBackgroundColorEven: surface,
      attributeBackgroundColorOdd: surfaceAlt,
      background,
      border2: borderStrong,
      border1: border,
      branchLabelColor: darkMode ? background : edgeLabelBackground,
      cScale0: diagramScale[0],
      cScale1: diagramScale[1],
      cScale2: diagramScale[2],
      cScale3: diagramScale[3],
      cScale4: diagramScale[4],
      cScale5: diagramScale[5],
      cScale6: diagramScale[0],
      cScale7: diagramScale[1],
      cScale8: diagramScale[2],
      cScale9: diagramScale[3],
      cScale10: diagramScale[4],
      cScale11: diagramScale[5],
      ...buildIndexedThemeVariables("cScaleInv", diagramScaleContrast, themeColorLimit),
      ...buildIndexedThemeVariables("cScaleLabel", diagramScaleLabels, themeColorLimit),
      ...buildIndexedThemeVariables("cScalePeer", diagramScalePeer, themeColorLimit),
      classText: text,
      clusterBkg: clusterBackground,
      clusterBorder: border,
      commitLabelBackground: surfaceAlt,
      commitLabelColor: text,
      commitLabelFontSize: tagFontSize,
      compositeBackground: surface,
      compositeBorder: border,
      compositeTitleBackground: surfaceAlt,
      critBkgColor: taskCriticalBackground,
      critBorderColor: danger,
      cynefin: {
        arrowColor: line,
        arrowWidth: 2,
        boundaryColor: border,
        boundaryWidth: 2,
        chaoticBg: taskCriticalBackground,
        clearBg: taskActiveBackground,
        cliffColor: danger,
        cliffWidth: 4,
        complexBg: taskDoneBackground,
        complicatedBg: noteBackground,
        confusionBg: surfaceAlt,
        domainFontSize: Math.max(14, Math.round(fontSize)),
        itemFontSize: Math.max(11, Math.round(fontSize * 0.75)),
        labelColor: text,
        textColor: text,
      },
      darkTextColor: text,
      darkMode,
      defaultLinkColor: line,
      doneTaskBkgColor: taskDoneBackground,
      doneTaskBorderColor: success,
      dropShadow: "none",
      edgeLabelBackground,
      emArrowhead: line,
      emCommandFill: noteBackground,
      emCommandStroke: info,
      emEventFill: taskActiveBackground,
      emEventStroke: warning,
      emProcessorFill: taskCriticalBackground,
      emProcessorStroke: danger,
      emReadModelFill: taskDoneBackground,
      emReadModelStroke: success,
      emRelationStroke: line,
      emSwimlaneBackgroundOdd: surfaceAlt,
      emSwimlaneBackgroundStroke: border,
      emUiFill: surface,
      emUiStroke: border,
      errorBkgColor: taskCriticalBackground,
      errorTextColor: text,
      excludeBkgColor: surfaceAlt,
      fillType0: journeyFills[0],
      fillType1: journeyFills[1],
      fillType2: journeyFills[2],
      fillType3: journeyFills[3],
      fillType4: journeyFills[4],
      fillType5: journeyFills[5],
      fillType6: journeyFills[0],
      fillType7: journeyFills[1],
      fontFamily,
      fontSize: bodyFontSize,
      fontWeight: "400",
      git0: gitPalette[0],
      git1: gitPalette[1],
      git2: gitPalette[2],
      git3: gitPalette[3],
      git4: gitPalette[4],
      git5: gitPalette[5],
      git6: gitPalette[6],
      git7: gitPalette[7],
      ...buildIndexedThemeVariables("gitBranchLabel", branchLabelPalette, 8),
      ...buildIndexedThemeVariables("gitInv", gitContrast, 8),
      gradientStart: borderStrong,
      gradientStop: border,
      gridColor: border,
      innerEndBackground: surfaceAlt,
      labelColor: text,
      labelBackground: edgeLabelBackground,
      labelBackgroundColor: edgeLabelBackground,
      labelBoxBkgColor: surface,
      labelBoxBorderColor: border,
      labelTextColor: text,
      lineColor: line,
      loopTextColor: text,
      mainBkg: surface,
      nodeBkg: surface,
      nodeBorder: borderStrong,
      nodeTextColor: text,
      noteBkgColor: noteBackground,
      noteBorderColor: border,
      noteFontWeight: "400",
      noteTextColor: text,
      personBkg: surface,
      personBorder: borderStrong,
      pie1: scale[0],
      pie2: scale[1],
      pie3: scale[2],
      pie4: scale[3],
      pie5: scale[4],
      pie6: scale[5],
      pie7: scale[0],
      pie8: scale[1],
      pie9: scale[2],
      pie10: scale[3],
      pie11: scale[4],
      pie12: scale[5],
      pieLegendTextColor: text,
      pieLegendTextSize: pieTextFontSize,
      pieOuterStrokeColor: background,
      pieOuterStrokeWidth: "2px",
      pieOpacity: "0.9",
      pieSectionTextColor: background,
      pieSectionTextSize: pieTextFontSize,
      pieStrokeColor: background,
      pieStrokeWidth: "2px",
      pieTitleTextColor: text,
      pieTitleTextSize: pieTitleFontSize,
      primaryBorderColor: borderStrong,
      primaryColor: surface,
      primaryTextColor: text,
      quadrant1Fill: surface,
      quadrant1TextFill: text,
      quadrant2Fill: surfaceAlt,
      quadrant2TextFill: text,
      quadrant3Fill: surface,
      quadrant3TextFill: text,
      quadrant4Fill: surfaceAlt,
      quadrant4TextFill: text,
      quadrantExternalBorderStrokeFill: border,
      quadrantInternalBorderStrokeFill: border,
      quadrantPointFill: accent,
      quadrantPointTextFill: text,
      quadrantTitleFill: text,
      quadrantXAxisTextFill: mutedText,
      quadrantYAxisTextFill: mutedText,
      relationColor: line,
      relationLabelBackground: edgeLabelBackground,
      relationLabelColor: text,
      radar: {
        axisColor: line,
        axisLabelFontSize: Math.max(11, Math.round(fontSize * 0.75)),
        axisStrokeWidth: 2,
        curveOpacity: 0.55,
        curveStrokeWidth: 2,
        graticuleColor: border,
        graticuleOpacity: 0.35,
        graticuleStrokeWidth: 1,
        legendBoxSize: Math.max(10, Math.round(fontSize * 0.75)),
        legendFontSize: Math.max(11, Math.round(fontSize * 0.75)),
      },
      radius,
      rectBkgColor: surfaceAlt,
      requirementBackground: surface,
      requirementBorderColor: border,
      requirementBorderSize: "1",
      requirementTextColor: text,
      rowEven: surface,
      rowOdd: surfaceAlt,
      scaleLabelColor: text,
      secondaryBorderColor: border,
      secondaryColor: surfaceAlt,
      secondaryTextColor: text,
      sectionBkgColor: sectionBackground,
      sectionBkgColor2: surfaceAlt,
      sequenceNumberColor: background,
      secondBkg: surfaceAlt,
      signalColor: line,
      signalTextColor: text,
      specialStateColor: warning,
      stateBkg: surface,
      stateLabelColor: text,
      strokeWidth,
      ...buildIndexedThemeVariables("surface", surfacePalette, surfacePalette.length),
      ...buildIndexedThemeVariables("surfacePeer", surfacePeerPalette, surfacePeerPalette.length),
      tagLabelBackground: surfaceAlt,
      tagLabelBorder: accentAlt,
      tagLabelColor: text,
      tagLabelFontSize: tagFontSize,
      taskBkgColor: taskBackground,
      taskBorderColor: border,
      taskTextClickableColor: accentAlt,
      taskTextColor: text,
      taskTextDarkColor: text,
      taskTextLightColor: background,
      taskTextOutsideColor: text,
      tertiaryBorderColor: border,
      tertiaryColor: background,
      tertiaryTextColor: text,
      textColor: text,
      titleColor: text,
      todayLineColor: danger,
      transitionColor: line,
      transitionLabelColor: text,
      useGradient: false,
      venn1: scale[0],
      venn2: scale[1],
      venn3: scale[2],
      venn4: scale[3],
      venn5: scale[4],
      venn6: scale[5],
      venn7: scale[0],
      venn8: scale[1],
      vennSetTextColor: text,
      vennTitleTextColor: text,
      vertLineColor: border,
      wardley: {
        annotationFill: surface,
        annotationStroke: border,
        annotationTextColor: text,
        axisColor: line,
        axisTextColor: text,
        backgroundColor: background,
        componentFill: surface,
        componentLabelColor: text,
        componentStroke: borderStrong,
        evolutionStroke: danger,
        gridColor: border,
        linkStroke: line,
      },
      wardleyEvolutionColor: danger,
      xyChart: {
        backgroundColor: background,
        dataLabelColor: text,
        plotColorPalette: xyChartScale.join(","),
        titleColor: text,
        xAxisLabelColor: mutedText,
        xAxisLineColor: border,
        xAxisTickColor: border,
        xAxisTitleColor: text,
        yAxisLabelColor: mutedText,
        yAxisLineColor: border,
        yAxisTickColor: border,
        yAxisTitleColor: text,
      },
    },
  };
}

function createCssTokenReader(root: HTMLElement): (name: string, fallback: string) => string {
  const style = root.ownerDocument.defaultView?.getComputedStyle(
    root.ownerDocument.documentElement,
  );
  return (name, fallback) => style?.getPropertyValue(name).trim() || fallback;
}

function normalizeCssTokenValue(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function parsePositiveCssNumber(value: string, fallback: number): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function repeatPalette(values: string[], count: number): string[] {
  return Array.from({ length: count }, (_, index) => values[index % values.length] ?? "");
}

function buildIndexedThemeVariables(
  prefix: string,
  values: string[],
  count: number,
): Record<string, string> {
  return Object.fromEntries(
    Array.from({ length: count }, (_, index) => [prefix + index, values[index] ?? ""]),
  );
}

function createMermaidRenderContainer(previewBody: HTMLElement, width: number): HTMLElement {
  const container = previewBody.ownerDocument.createElement("div");
  container.dataset.kukuCodeBlockMermaidRenderContainer = "";
  container.style.position = "absolute";
  container.style.left = "0";
  container.style.top = "0";
  container.style.width = `${width}px`;
  container.style.height = "1px";
  container.style.overflow = "visible";
  container.style.opacity = "0";
  container.style.pointerEvents = "none";
  previewBody.append(container);
  return container;
}

async function waitForMermaidRenderWidth(
  previewBody: HTMLElement,
  fallbackRoot: HTMLElement,
): Promise<number> {
  const win = previewBody.ownerDocument.defaultView ?? window;
  for (let attempt = 0; attempt < MERMAID_RENDER_LAYOUT_FRAME_LIMIT; attempt += 1) {
    const measuredWidth = getMeasuredMermaidRenderWidth(previewBody, fallbackRoot);
    if (measuredWidth > 0) {
      return Math.max(Math.ceil(measuredWidth), MERMAID_RENDER_MIN_WIDTH);
    }
    await new Promise<void>((resolve) => win.requestAnimationFrame(() => resolve()));
  }

  return MERMAID_RENDER_FALLBACK_WIDTH;
}

function getMeasuredMermaidRenderWidth(
  previewBody: HTMLElement,
  fallbackRoot: HTMLElement,
): number {
  const codeBlock = previewBody.closest<HTMLElement>("[data-kuku-code-block]");
  return Math.max(
    previewBody.clientWidth,
    previewBody.getBoundingClientRect().width,
    previewBody.parentElement?.clientWidth ?? 0,
    codeBlock?.clientWidth ?? 0,
    fallbackRoot.clientWidth,
    fallbackRoot.getBoundingClientRect().width,
  );
}

function readComputedPixelValue(
  root: HTMLElement,
  propertyName: "fontSize",
  fallback: number,
): number {
  const style = root.ownerDocument.defaultView?.getComputedStyle(root);
  const rawValue = style?.[propertyName] ?? "";
  const value = Number.parseFloat(rawValue);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

async function waitForMermaidFonts(
  root: HTMLElement,
  source: string,
  config: MermaidConfig,
): Promise<void> {
  const fonts = root.ownerDocument.fonts;
  const fontFamily = normalizeCssTokenValue(config.fontFamily ?? "");
  if (!fonts || !fontFamily) return;

  const fontSize =
    typeof config.fontSize === "number" && config.fontSize > 0 ? config.fontSize : 16;
  const sample = `${source.slice(0, 512)} ${MERMAID_FONT_PRELOAD_SAMPLE_TEXT}`;
  const loadSpecs = [
    `${fontSize}px ${fontFamily}`,
    `500 ${fontSize}px ${fontFamily}`,
    `700 ${fontSize}px ${fontFamily}`,
  ];

  await Promise.allSettled(loadSpecs.map((spec) => loadFontFace(fonts, spec, sample)));
  await fonts.ready.catch(() => undefined);
  await waitForNextAnimationFrame(root.ownerDocument);
}

function loadFontFace(fonts: FontFaceSet, spec: string, sample: string): Promise<FontFace[]> {
  try {
    return fonts.load(spec, sample);
  } catch {
    return Promise.resolve([]);
  }
}

function waitForNextAnimationFrame(doc: Document): Promise<void> {
  return new Promise((resolve) => {
    const win = doc.defaultView;
    if (!win) {
      resolve();
      return;
    }
    win.requestAnimationFrame(() => resolve());
  });
}

function loadMermaid(): Promise<Mermaid> {
  if (!mermaidLoader) {
    mermaidLoader = import("mermaid").then(({ default: mermaid }) => {
      mermaid.initialize(buildMermaidConfig(document.documentElement));
      return mermaid;
    });
  }
  return mermaidLoader;
}

function resolveHighlightLanguage(language: string): string | null {
  const normalized = language.trim().toLowerCase();
  if (!normalized) return null;
  if (highlighter.getLanguage(normalized)) return normalized;

  const aliases: Record<string, string> = {
    cjs: "javascript",
    js: "javascript",
    jsx: "javascript",
    mjs: "javascript",
    py: "python",
    rb: "ruby",
    sh: "bash",
    shell: "bash",
    ts: "typescript",
    tsx: "typescript",
    yml: "yaml",
  };
  const alias = aliases[normalized];
  return alias && highlighter.getLanguage(alias) ? alias : null;
}

function createEditIcon(): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");

  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M12 20h9");
  svg.append(path);

  const editPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
  editPath.setAttribute("d", "M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z");
  svg.append(editPath);

  return svg;
}

if (import.meta.env.DEV && typeof window !== "undefined") {
  installCodeBlockDebugHelper(window);
}

export { CodeMirrorCodeBlockView, defineCodeMirrorCodeBlockView };
