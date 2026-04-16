import type { ChatMessageAttachment, EditorContext } from "./types";

const MAX_SELECTED_TEXT_BYTES = 20 * 1024;

interface PreparedSelectedTextContext {
  selectedText: string | null;
  messageAttachment?: ChatMessageAttachment;
}

function prepareSelectedTextForSend(
  editorContext: EditorContext,
  includeSelectedText = true,
): PreparedSelectedTextContext {
  const selectedText = includeSelectedText ? editorContext.selectedText : null;
  if (!selectedText || selectedText.trim().length === 0) {
    return { selectedText: null };
  }

  const sizeBytes = byteSize(selectedText);
  if (sizeBytes > MAX_SELECTED_TEXT_BYTES) {
    throw new Error(
      `Selected text is too large to include (${formatBytes(sizeBytes)}). Limit: ${formatBytes(
        MAX_SELECTED_TEXT_BYTES,
      )}.`,
    );
  }

  return {
    selectedText,
    messageAttachment: {
      kind: "selection",
      activeFile: editorContext.activeFile,
      sizeBytes,
    },
  };
}

function byteSize(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${Math.ceil(bytes / 1024)} KB`;
}

export { MAX_SELECTED_TEXT_BYTES, prepareSelectedTextForSend };
export type { PreparedSelectedTextContext };
