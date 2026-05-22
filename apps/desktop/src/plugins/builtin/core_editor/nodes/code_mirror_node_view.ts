import { defaultKeymap } from "@codemirror/commands";
import { EditorState as CodeMirrorState } from "@codemirror/state";
import {
  drawSelection,
  EditorView as CodeMirrorView,
  keymap as codeMirrorKeymap,
  type KeyBinding,
  type ViewUpdate,
} from "@codemirror/view";
import { defineNodeView, definePlugin, union, type Extension } from "prosekit/core";
import type { Node as ProseMirrorNode } from "prosekit/pm/model";
import { exitCode } from "prosekit/pm/commands";
import { redo, undo } from "prosekit/pm/history";
import { Plugin } from "prosekit/pm/state";
import { Selection, TextSelection } from "prosekit/pm/state";
import type {
  Decoration,
  DecorationSource,
  EditorView as ProseMirrorView,
  NodeView,
} from "prosekit/pm/view";

type GetPos = () => number | undefined;
type Fence = "```" | "~~~";
interface ParsedCodeMirrorDoc {
  code: string;
  codeStart: number;
  fence: Fence;
  language: string;
}

let mermaidLoader: Promise<typeof import("mermaid").default> | null = null;
let highlightLoader: Promise<typeof import("highlight.js").default> | null = null;
let nextMermaidId = 0;
let pendingCodeBlockEntrySide: -1 | 1 | null = null;

class CodeMirrorCodeBlockView implements NodeView {
  dom: HTMLElement;
  private cm: CodeMirrorView;
  private editorChrome: HTMLElement;
  private editing: boolean;
  private getPos: GetPos;
  private node: ProseMirrorNode;
  private preview: HTMLElement;
  private previewBody: HTMLElement;
  private previewRenderToken = 0;
  private updating = false;
  private view: ProseMirrorView;

  constructor(node: ProseMirrorNode, view: ProseMirrorView, getPos: GetPos) {
    this.node = node;
    this.view = view;
    this.getPos = getPos;
    this.dom = document.createElement("div");
    this.dom.dataset.kukuCodeBlock = "";
    this.dom.dataset.kukuCodeMirrorBlock = "";
    this.editing = false;

    this.editorChrome = document.createElement("div");
    this.editorChrome.dataset.kukuCodeBlockEditor = "";

    const editorHost = document.createElement("div");
    editorHost.dataset.kukuCodeMirrorHost = "";

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

    this.editorChrome.append(editorHost);
    this.dom.append(this.preview, this.editorChrome);
    this.dom.addEventListener("focusout", () => {
      window.setTimeout(() => {
        if (!this.dom.contains(this.dom.ownerDocument.activeElement)) {
          this.exitEditMode();
        }
      });
    });

    this.cm = new CodeMirrorView({
      doc: formatCodeMirrorDoc(node),
      extensions: [
        codeMirrorKeymap.of([...this.codeMirrorKeymap(), ...defaultKeymap]),
        drawSelection(),
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

    const codeStart = codeStartOffset(this.node);
    const entrySide = pendingCodeBlockEntrySide;
    pendingCodeBlockEntrySide = null;
    const anchorOffset = this.toCodeMirrorSelectionOffset(anchor, entrySide, codeStart);
    const headOffset = this.toCodeMirrorSelectionOffset(head, entrySide, codeStart);
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
    _decorations: readonly Decoration[],
    _innerDecorations: DecorationSource,
  ): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.syncRenderedMode();
    if (this.updating) return true;

    const nextText = formatCodeMirrorDoc(node);
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
    const parsed = parseCodeMirrorDoc(update.state.doc.toString(), this.node);
    if (!parsed) return;

    const { main } = update.state.selection;
    const selectionFrom = pos + 1 + clamp(main.from - parsed.codeStart, 0, parsed.code.length);
    const selectionTo = pos + 1 + clamp(main.to - parsed.codeStart, 0, parsed.code.length);
    const currentSelection = this.view.state.selection;
    const attrsChanged =
      parsed.fence !== readFence(this.node) || parsed.language !== readLanguage(this.node);
    const codeChanged = parsed.code !== this.node.textContent;
    const selectionChanged =
      currentSelection.from !== selectionFrom || currentSelection.to !== selectionTo;

    if (!attrsChanged && !codeChanged && !selectionChanged) {
      return;
    }

    let tr = this.view.state.tr;
    if (attrsChanged) {
      tr = tr.setNodeMarkup(pos, undefined, {
        ...this.node.attrs,
        fence: parsed.fence,
        language: parsed.language,
      });
    }
    if (codeChanged) {
      const from = pos + 1;
      const to = pos + 1 + this.node.content.size;
      if (parsed.code) {
        tr = tr.replaceWith(from, to, this.view.state.schema.text(parsed.code));
      } else {
        tr = tr.delete(from, to);
      }
    }

    tr = tr.setSelection(TextSelection.create(tr.doc, selectionFrom, selectionTo));
    this.updating = true;
    this.view.dispatch(tr);
    this.updating = false;
  }

  private maybeEscape(unit: "char" | "line", direction: -1 | 1): boolean {
    let { main } = this.cm.state.selection;
    if (!main.empty) return false;
    if (unit === "line") main = this.cm.state.doc.lineAt(main.head);
    if (direction < 0 ? main.from > 0 : main.to < this.cm.state.doc.length) return false;

    const pos = this.getPos();
    if (typeof pos !== "number") return false;
    const targetPos = pos + (direction < 0 ? 0 : this.node.nodeSize);
    const selection = Selection.near(this.view.state.doc.resolve(targetPos), direction);
    this.view.dispatch(this.view.state.tr.setSelection(selection).scrollIntoView());
    this.view.focus();
    return true;
  }

  private toCodeMirrorSelectionOffset(
    offset: number,
    entrySide: -1 | 1 | null,
    codeStart: number,
  ): number {
    if (entrySide === 1 || offset <= 0) {
      return 0;
    }
    if (entrySide === -1 || offset >= this.node.content.size) {
      return this.cm.state.doc.length;
    }
    return codeStart + offset;
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
    this.editing = false;
    this.syncRenderedMode();
  }

  private syncRenderedMode(): void {
    this.editorChrome.hidden = !this.editing;
    this.preview.hidden = this.editing;
    if (!this.editing) {
      this.renderPreview();
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

    loadHighlighter()
      .then((highlighter) => {
        if (token !== this.previewRenderToken) return;
        const highlightLanguage = resolveHighlightLanguage(highlighter, language);
        if (!highlightLanguage) return;
        code.className = `hljs language-${language}`;
        code.innerHTML = highlighter.highlight(this.node.textContent, {
          ignoreIllegals: true,
          language: highlightLanguage,
        }).value;
      })
      .catch(() => {
        // Keep the already-rendered plain code preview if highlighting fails.
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
        this.previewBody.textContent = error instanceof Error ? error.message : "Unable to render diagram";
      });
  }
}

function defineCodeMirrorCodeBlockView(): Extension {
  return union(
    defineNodeView({
      name: "codeBlock",
      constructor: (node, view, getPos) => new CodeMirrorCodeBlockView(node, view, getPos as GetPos),
    }),
    definePlugin(
      new Plugin({
        props: {
          handleKeyDown: (view, event) => {
            if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return false;
            return arrowHandler(event.key.replace("Arrow", "").toLowerCase())(view);
          },
        },
      }),
    ),
  );
}

function arrowHandler(direction: string): (view: ProseMirrorView) => boolean {
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

function readFence(node: ProseMirrorNode): Fence {
  return node.attrs.fence === "~~~" ? "~~~" : "```";
}

function readLanguage(node: ProseMirrorNode): string {
  return typeof node.attrs.language === "string" ? node.attrs.language : "";
}

function isMermaidNode(node: ProseMirrorNode): boolean {
  return readLanguage(node).trim().toLowerCase() === "mermaid";
}

function formatOpeningFence(fence: Fence, language: string): string {
  return `${fence}${language}`;
}

function formatCodeMirrorDoc(node: ProseMirrorNode): string {
  const fence = readFence(node);
  return `${formatOpeningFence(fence, readLanguage(node))}\n${node.textContent}\n${fence}`;
}

function codeStartOffset(node: ProseMirrorNode): number {
  return formatOpeningFence(readFence(node), readLanguage(node)).length + 1;
}

function parseCodeMirrorDoc(value: string, previousNode: ProseMirrorNode): ParsedCodeMirrorDoc | null {
  const firstLineEnd = value.indexOf("\n");
  if (firstLineEnd === -1) return null;

  const opening = parseOpeningFence(value.slice(0, firstLineEnd));
  if (!opening) return null;

  const codeStart = firstLineEnd + 1;
  const lastLineStart = value.lastIndexOf("\n");
  const closing = lastLineStart >= codeStart ? parseClosingFence(value.slice(lastLineStart + 1)) : null;
  const codeEnd = closing ? lastLineStart : value.length;
  const previousFence = readFence(previousNode);
  const fence =
    opening.fence === previousFence && closing && closing !== previousFence ? closing : opening.fence;

  return {
    code: value.slice(codeStart, codeEnd),
    codeStart,
    fence,
    language: opening.language,
  };
}

function parseOpeningFence(value: string): { fence: Fence; language: string } | null {
  const match = /^(?<fence>```|~~~)(?<language>[^\s`~]*)\s*$/.exec(value.trim());
  if (!match?.groups) return null;
  return {
    fence: match.groups.fence === "~~~" ? "~~~" : "```",
    language: match.groups.language ?? "",
  };
}

function parseClosingFence(value: string): Fence | null {
  const trimmed = value.trim();
  return trimmed === "```" || trimmed === "~~~" ? trimmed : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function loadMermaid(): Promise<typeof import("mermaid").default> {
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

function loadHighlighter(): Promise<typeof import("highlight.js").default> {
  if (!highlightLoader) {
    highlightLoader = import("highlight.js").then(({ default: highlighter }) => highlighter);
  }
  return highlightLoader;
}

function resolveHighlightLanguage(
  highlighter: typeof import("highlight.js").default,
  language: string,
): string | null {
  const normalized = language.trim().toLowerCase();
  if (!normalized) return null;
  if (highlighter.getLanguage(normalized)) return normalized;

  const aliases: Record<string, string> = {
    cjs: "javascript",
    js: "javascript",
    jsx: "javascript",
    mjs: "javascript",
    ts: "typescript",
    tsx: "typescript",
    py: "python",
    rb: "ruby",
    sh: "bash",
    shell: "bash",
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
