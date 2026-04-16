import { readVaultFileWithChecksum, type FileEntry } from "~/lib/vault_fs";
import {
  filterWikilinkSuggestions,
  flattenMarkdownFiles,
  type WikilinkSuggestItem,
} from "~/plugins/builtin/wikilink/wikilink_suggest";

import type { ChatFileAttachmentDraft, ChatMessageAttachment, EmbeddedFileContext } from "./types";

const MAX_FILE_ATTACHMENTS = 5;
const MAX_EMBEDDED_FILE_BYTES = 50 * 1024;
const MAX_TOTAL_EMBEDDED_BYTES = 150 * 1024;
const MAX_FILE_SUGGESTIONS = 20;

interface FileMentionTrigger {
  from: number;
  to: number;
  query: string;
}

interface PreparedEmbeddedFiles {
  embeddedFiles: EmbeddedFileContext[];
  messageAttachments: ChatMessageAttachment[];
}

function resolveFileMentionTrigger(text: string, caret: number): FileMentionTrigger | null {
  if (caret < 0 || caret > text.length) return null;

  const beforeCaret = text.slice(0, caret);
  let tokenStart = beforeCaret.length;
  while (tokenStart > 0 && !/\s/.test(beforeCaret[tokenStart - 1] ?? "")) {
    tokenStart -= 1;
  }

  const token = beforeCaret.slice(tokenStart);
  if (!token.startsWith("@")) return null;
  if (token.length > 1 && token.includes("\n")) return null;

  return {
    from: tokenStart,
    to: caret,
    query: token.slice(1),
  };
}

function getFileEmbedSuggestions(entries: FileEntry[], query: string): WikilinkSuggestItem[] {
  return filterWikilinkSuggestions(flattenMarkdownFiles(entries), query).slice(
    0,
    MAX_FILE_SUGGESTIONS,
  );
}

function fileAttachmentFromSuggestion(item: WikilinkSuggestItem): ChatFileAttachmentDraft {
  return {
    path: item.path,
    name: item.name,
    folder: item.folder,
  };
}

function appendFileAttachment(
  current: readonly ChatFileAttachmentDraft[],
  attachment: ChatFileAttachmentDraft,
): ChatFileAttachmentDraft[] {
  if (current.some((item) => item.path === attachment.path)) {
    return [...current];
  }
  if (current.length >= MAX_FILE_ATTACHMENTS) {
    throw new Error(`You can attach up to ${MAX_FILE_ATTACHMENTS} files.`);
  }
  return [...current, attachment];
}

async function prepareEmbeddedFilesForSend(
  attachments: readonly ChatFileAttachmentDraft[],
): Promise<PreparedEmbeddedFiles> {
  if (attachments.length > MAX_FILE_ATTACHMENTS) {
    throw new Error(`You can attach up to ${MAX_FILE_ATTACHMENTS} files.`);
  }

  const embeddedFiles: EmbeddedFileContext[] = [];
  const messageAttachments: ChatMessageAttachment[] = [];
  let totalSizeBytes = 0;

  for (const attachment of attachments) {
    let result;
    try {
      result = await readVaultFileWithChecksum(attachment.path);
    } catch (error) {
      throw new Error(`Failed to attach ${attachment.path}: ${errorMessage(error)}`, {
        cause: error,
      });
    }

    const sizeBytes = byteSize(result.content);
    if (sizeBytes > MAX_EMBEDDED_FILE_BYTES) {
      throw new Error(
        `${attachment.path} is too large to attach (${formatBytes(sizeBytes)}). Limit: ${formatBytes(
          MAX_EMBEDDED_FILE_BYTES,
        )}.`,
      );
    }

    totalSizeBytes += sizeBytes;
    if (totalSizeBytes > MAX_TOTAL_EMBEDDED_BYTES) {
      throw new Error(
        `Attached files are too large (${formatBytes(totalSizeBytes)}). Limit: ${formatBytes(
          MAX_TOTAL_EMBEDDED_BYTES,
        )}.`,
      );
    }

    embeddedFiles.push({
      path: attachment.path,
      content: result.content,
      checksum: result.checksum,
      sizeBytes,
    });
    messageAttachments.push({
      kind: "file",
      path: attachment.path,
      name: attachment.name,
      sizeBytes,
    });
  }

  return { embeddedFiles, messageAttachments };
}

function byteSize(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${Math.ceil(bytes / 1024)} KB`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export {
  MAX_FILE_ATTACHMENTS,
  appendFileAttachment,
  fileAttachmentFromSuggestion,
  getFileEmbedSuggestions,
  prepareEmbeddedFilesForSend,
  resolveFileMentionTrigger,
};
export type { FileMentionTrigger, PreparedEmbeddedFiles };
