import type { PMNodeJSON } from "./types";

import { getMarkdownService } from "~/plugins/markdown_service";

const EMPTY_DOC: PMNodeJSON = { type: "doc", content: [] };

function markdownToProseMirror(source: string): PMNodeJSON {
  const service = getMarkdownService();
  if (!service) return EMPTY_DOC;
  return service.parse(source);
}

function proseMirrorToMarkdown(doc: PMNodeJSON): string {
  const service = getMarkdownService();
  if (!service) return "";
  return service.stringify(doc);
}

export { markdownToProseMirror, proseMirrorToMarkdown };
