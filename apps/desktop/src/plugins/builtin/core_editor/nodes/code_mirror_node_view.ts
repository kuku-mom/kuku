import { defaultKeymap } from "@codemirror/commands";
import {
  EditorState as CodeMirrorState,
  RangeSetBuilder,
  StateEffect,
  StateField,
  type Extension as CodeMirrorExtension,
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

    this.editorChrome = document.createElement("div");
    this.editorChrome.dataset.kukuCodeBlockEditor = "";
    this.editorChrome.addEventListener("focusin", () => this.setFenceChromeVisible(true));
    this.editorChrome.addEventListener("focusout", () => {
      window.setTimeout(() => {
        if (!this.editorChrome.contains(this.dom.ownerDocument.activeElement)) {
          this.setFenceChromeVisible(false);
        }
      });
    });

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
        CodeMirrorView.lineWrapping,
        CodeMirrorView.updateListener.of((update) => this.forwardUpdate(update)),
        CodeMirrorState.tabSize.of(2),
      ],
      parent: editorHost,
    });
    this.syncRenderedMode();
  }

  destroy(): void {
    this.previewRenderToken += 1;
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
    }
  }

  private syncBehaviorDataset(): void {
    this.dom.dataset.kukuCodeBlockBehavior = this.behavior;
  }

  private setFenceChromeVisible(visible: boolean): void {
    if (visible) {
      this.dom.dataset.kukuCodeBlockFenceVisible = "";
      this.languageInput.tabIndex = 0;
    } else {
      delete this.dom.dataset.kukuCodeBlockFenceVisible;
      this.languageInput.tabIndex = -1;
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
      .then((mermaid) => mermaid.render(`kuku-editor-mermaid-${nextMermaidId++}`, source))
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

function loadMermaid(): Promise<Mermaid> {
  if (!mermaidLoader) {
    mermaidLoader = import("mermaid").then(({ default: mermaid }) => {
      mermaid.initialize({
        fontFamily: "inherit",
        securityLevel: "strict",
        startOnLoad: false,
        theme: "neutral",
      });
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

export { CodeMirrorCodeBlockView, defineCodeMirrorCodeBlockView };
