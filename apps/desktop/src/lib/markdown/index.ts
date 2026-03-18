// ── Core conversion ──
export { mdastToProseMirror } from "./mdast_to_pm";
export { proseMirrorToMdast, createTextInlineHandler, extractTextContent } from "./pm_to_mdast";
export { markdownToProseMirror, proseMirrorToMarkdown } from "./roundtrip";

// ── Types ──
export type {
  PMMarkJSON,
  PMNodeJSON,
  ConversionRegistry,
  MdastToPmContext,
  PmToMdastContext,
  MdastToPmBlockHandler,
  MdastToPmInlineHandler,
  PmToMdastBlockHandler,
  PmToMdastInlineHandler,
  PmToMdastMarkHandler,
} from "./types";
export { createEmptyRegistry, mergeRegistries } from "./types";

// ── Registry ──
export { RegistryBuilder, createBaseRegistry } from "./registry";

// ── Processor ──
export { createProcessor } from "./processor";
export type { CreateProcessorOptions, MarkdownProcessor, RemarkPlugin } from "./processor";

// ── Base handlers ──
export {
  paragraphHandler as mdastParagraphHandler,
  textHandler as mdastTextHandler,
  breakHandler as mdastBreakHandler,
  // Helpers for plugin handler authors
  convertMarkChildren,
  makeText,
} from "./mdast_to_pm";

export {
  paragraphHandler as pmParagraphHandler,
  textInlineHandler as pmTextInlineHandler,
  hardBreakInlineHandler as pmHardBreakInlineHandler,
} from "./pm_to_mdast";
