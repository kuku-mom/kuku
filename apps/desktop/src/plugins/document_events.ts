import type { Node as ProseMirrorNode } from "prosekit/pm/model";
import { emitEvent } from "./events";

/** Selection and plugin-state transactions must not invalidate document readers. */
export function notifyDocumentChanged(
  path: string,
  previous: ProseMirrorNode,
  next: ProseMirrorNode,
): void {
  if (!previous.eq(next)) emitEvent("editor:documentChanged", { filePath: path });
}

export function notifyDocumentSaved(path: string, content: string): void {
  emitEvent("editor:saved", { filePath: path, content });
}
