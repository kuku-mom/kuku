import { TextSelection } from "prosekit/pm/state";
import type { Node as ProseMirrorNode } from "prosekit/pm/model";
import type { EditorView } from "prosekit/pm/view";

interface EditorEndPointerEvent {
  altKey: boolean;
  button: number;
  clientX: number;
  clientY: number;
  ctrlKey: boolean;
  defaultPrevented: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  target: EventTarget | null;
}

function isEmptyParagraph(node: ProseMirrorNode | null): node is ProseMirrorNode {
  return node?.type.name === "paragraph" && node.content.size === 0;
}

function lastVisibleEditorChild(editorDom: HTMLElement): HTMLElement | null {
  const children = [...editorDom.children];
  for (let index = children.length - 1; index >= 0; index -= 1) {
    const child = children[index];
    if (!(child instanceof HTMLElement)) continue;

    const rect = child.getBoundingClientRect();
    if (rect.width > 0 || rect.height > 0) {
      return child;
    }
  }
  return null;
}

function isPointInsideRect(x: number, y: number, rect: DOMRect): boolean {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

function isEditorEndBlankPointerDown(
  event: EditorEndPointerEvent,
  editorDom: HTMLElement,
): boolean {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey
  ) {
    return false;
  }

  if (!(event.target instanceof Node) || event.target !== editorDom) {
    return false;
  }

  const editorRect = editorDom.getBoundingClientRect();
  if (!isPointInsideRect(event.clientX, event.clientY, editorRect)) {
    return false;
  }

  const lastChild = lastVisibleEditorChild(editorDom);
  if (!lastChild) {
    return true;
  }

  return event.clientY >= lastChild.getBoundingClientRect().bottom;
}

function focusOrCreateEditorEndParagraph(view: EditorView): boolean {
  const paragraph = view.state.schema.nodes.paragraph;
  if (!paragraph) return false;

  const { doc } = view.state;
  const lastChild = doc.lastChild;

  if (isEmptyParagraph(lastChild)) {
    const paragraphStart = doc.content.size - lastChild.nodeSize;
    const selection = TextSelection.create(doc, paragraphStart + 1);
    view.dispatch(view.state.tr.setSelection(selection).scrollIntoView());
    view.focus();
    return true;
  }

  const insertPos = doc.content.size;
  const node = paragraph.createAndFill();
  if (!node) return false;

  const tr = view.state.tr.insert(insertPos, node);
  tr.setSelection(TextSelection.create(tr.doc, insertPos + 1));
  view.dispatch(tr.scrollIntoView());
  view.focus();
  return true;
}

export { focusOrCreateEditorEndParagraph, isEditorEndBlankPointerDown };
