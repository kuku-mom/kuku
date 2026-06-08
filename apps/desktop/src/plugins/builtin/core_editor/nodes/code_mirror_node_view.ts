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

type GetPos = () => number | undefined;
type ArrowDirection = "left" | "right" | "up" | "down";
type CodeBlockBehavior = "plain" | "renderable";
type Mermaid = typeof mermaid;

let mermaidLoader: Promise<Mermaid> | null = null;
let nextMermaidId = 0;
let pendingCodeBlockEntrySide: -1 | 1 | null = null;
const codeBlockFenceSyncDocuments = new WeakSet<Document>();
const codeBlockFenceSyncFrames = new WeakMap<Document, number>();
const codeBlockFenceRepairViews = new WeakSet<ProseMirrorView>();
const codeBlockViewsByEditor = new WeakMap<ProseMirrorView, Set<CodeMirrorCodeBlockView>>();
const codeBlockViewByRoot = new WeakMap<HTMLElement, CodeMirrorCodeBlockView>();
const mermaidThemeObservers = new WeakMap<Document, MutationObserver>();
const mermaidThemeSyncFrames = new WeakMap<Document, number>();
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
    ensureMermaidThemeSync(this.dom.ownerDocument);
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
    this.previewBody.dataset.kukuCodeBlockMermaidPlaceholder = "";
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
    if (isMermaidNode(this.node)) {
      this.renderMermaidPreview();
    } else {
      this.renderCodePreview();
    }
  }

  private renderCodePreview(): void {
    const token = ++this.previewRenderToken;
    delete this.previewBody.dataset.kukuCodeBlockMermaidSvg;
    delete this.previewBody.dataset.kukuCodeBlockMermaidError;
    delete this.previewBody.dataset.kukuCodeBlockMermaidPlaceholder;
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

  private renderMermaidPreview(): void {
    const token = ++this.previewRenderToken;
    const source = this.node.textContent.trim();
    delete this.previewBody.dataset.kukuCodeBlockRenderedCode;
    delete this.previewBody.dataset.kukuCodeBlockMermaidSvg;
    delete this.previewBody.dataset.kukuCodeBlockMermaidError;
    this.previewBody.dataset.kukuCodeBlockMermaidPlaceholder = "";
    this.previewBody.textContent = "";

    if (!source) {
      this.previewBody.textContent = "Empty Mermaid diagram";
      return;
    }

    loadMermaid()
      .then((mermaid) => {
        mermaid.initialize(buildMermaidConfig(this.dom));
        return mermaid.render(`kuku-editor-mermaid-${nextMermaidId++}`, source);
      })
      .then(({ svg }) => {
        if (token !== this.previewRenderToken) return;
        this.previewBody.removeAttribute("data-kuku-code-block-mermaid-placeholder");
        delete this.previewBody.dataset.kukuCodeBlockMermaidError;
        this.previewBody.dataset.kukuCodeBlockMermaidSvg = "";
        this.previewBody.innerHTML = svg;
      })
      .catch((error: unknown) => {
        if (token !== this.previewRenderToken) return;
        this.previewBody.removeAttribute("data-kuku-code-block-mermaid-placeholder");
        delete this.previewBody.dataset.kukuCodeBlockMermaidSvg;
        this.previewBody.dataset.kukuCodeBlockMermaidError = "";
        this.previewBody.textContent =
          error instanceof Error ? error.message : "Unable to render diagram";
      });
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

  refreshMermaidTheme(): void {
    if (this.behavior === "renderable" && !this.editing) {
      this.renderPreview();
    }
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

function ensureMermaidThemeSync(doc: Document): void {
  if (mermaidThemeObservers.has(doc)) return;

  const observer = new MutationObserver(() => scheduleMermaidThemeSync(doc));
  observer.observe(doc.documentElement, {
    attributeFilter: ["data-theme", "style"],
    attributes: true,
  });
  mermaidThemeObservers.set(doc, observer);
}

function scheduleMermaidThemeSync(doc: Document): void {
  const win = doc.defaultView;
  if (!win || mermaidThemeSyncFrames.has(doc)) return;

  const frame = win.requestAnimationFrame(() => {
    mermaidThemeSyncFrames.delete(doc);
    syncMermaidTheme(doc);
  });
  mermaidThemeSyncFrames.set(doc, frame);
}

function syncMermaidTheme(doc: Document): void {
  for (const block of doc.querySelectorAll<HTMLElement>(
    '[data-kuku-code-mirror-block][data-kuku-code-block-behavior="renderable"]',
  )) {
    codeBlockViewByRoot.get(block)?.refreshMermaidTheme();
  }
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

function isMermaidNode(node: ProseMirrorNode): boolean {
  return readLanguage(node).trim().toLowerCase() === "mermaid";
}

function resolveCodeBlockBehavior(node: ProseMirrorNode): CodeBlockBehavior {
  return isMermaidNode(node) ? "renderable" : "plain";
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

registerMermaidHighlightLanguage();

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
  const scale = [
    readToken("--color-mermaid-scale-1", accent),
    readToken("--color-mermaid-scale-2", mutedText),
    readToken("--color-mermaid-scale-3", success),
    readToken("--color-mermaid-scale-4", warning),
    readToken("--color-mermaid-scale-5", danger),
    readToken("--color-mermaid-scale-6", info),
  ];

  return {
    fontFamily: "inherit",
    securityLevel: "strict",
    startOnLoad: false,
    theme: "base",
    themeVariables: {
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
      arrowheadColor: line,
      background,
      border2: borderStrong,
      cScale0: scale[0],
      cScale1: scale[1],
      cScale2: scale[2],
      cScale3: scale[3],
      cScale4: scale[4],
      cScale5: scale[5],
      cScale6: scale[0],
      cScale7: scale[1],
      cScale8: scale[2],
      cScale9: scale[3],
      cScale10: scale[4],
      cScale11: scale[5],
      classText: text,
      clusterBkg: clusterBackground,
      clusterBorder: border,
      commitLabelBackground: surfaceAlt,
      commitLabelColor: text,
      compositeBackground: surface,
      compositeBorder: border,
      compositeTitleBackground: surfaceAlt,
      critBkgColor: taskCriticalBackground,
      critBorderColor: danger,
      darkTextColor: text,
      darkMode,
      defaultLinkColor: line,
      doneTaskBkgColor: taskDoneBackground,
      doneTaskBorderColor: success,
      edgeLabelBackground,
      errorBkgColor: taskCriticalBackground,
      errorTextColor: text,
      excludeBkgColor: surfaceAlt,
      fillType0: scale[0],
      fillType1: scale[1],
      fillType2: scale[2],
      fillType3: scale[3],
      fillType4: scale[4],
      fillType5: scale[5],
      fillType6: scale[0],
      fillType7: scale[1],
      fontFamily: "inherit",
      gridColor: border,
      labelColor: text,
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
      pieOuterStrokeColor: background,
      pieSectionTextColor: background,
      pieStrokeColor: background,
      pieTitleTextColor: text,
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
      quadrantPointTextFill: background,
      quadrantTitleFill: text,
      quadrantXAxisTextFill: mutedText,
      quadrantYAxisTextFill: mutedText,
      relationColor: line,
      relationLabelBackground: edgeLabelBackground,
      relationLabelColor: text,
      requirementBackground: surface,
      requirementBorderColor: border,
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
      signalColor: line,
      signalTextColor: text,
      specialStateColor: warning,
      stateBkg: surface,
      stateLabelColor: text,
      tagLabelBackground: surfaceAlt,
      tagLabelBorder: accentAlt,
      tagLabelColor: text,
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
      xyChart: {
        backgroundColor: background,
        plotColorPalette: scale,
        titleColor: text,
        xAxisLabelColor: mutedText,
        xAxisLineColor: border,
        xAxisTickColor: border,
        yAxisLabelColor: mutedText,
        yAxisLineColor: border,
        yAxisTickColor: border,
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
