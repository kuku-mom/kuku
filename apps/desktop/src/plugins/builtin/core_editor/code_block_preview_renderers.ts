import type { Disposer } from "~/plugins/types";

interface CodeBlockPreviewRenderContext {
  root: HTMLElement;
  previewBody: HTMLElement;
  editorRoot: HTMLElement;
  language: string;
  source: string;
  token: number;
  preserveCurrent: boolean;
  isCurrent(): boolean;
  lockHeight(): (() => void) | null;
}

interface CodeBlockPreviewEstimateContext {
  root: HTMLElement;
  editorRoot: HTMLElement;
  language: string;
  source: string;
  width: number;
}

interface CodeBlockPreviewRenderer {
  id: string;
  matches(language: string): boolean;
  render(ctx: CodeBlockPreviewRenderContext): void | Promise<void>;
  clear?(previewBody: HTMLElement): void;
  deferUntilVisible?: boolean;
  deferThemeRefreshUntilVisible?: boolean;
  estimateHeight?(ctx: CodeBlockPreviewEstimateContext): number | null;
  getCacheSignature?(ctx: CodeBlockPreviewEstimateContext): string | null;
  preserveOnRefresh?: boolean;
  preserveScrollAnchorOnRender?: boolean;
  refreshOnThemeChange?: boolean;
  reserveEstimatedHeight?: boolean;
}

interface RendererEntry {
  renderer: CodeBlockPreviewRenderer;
  sequence: number;
}

let nextSequence = 0;
const rendererEntries = new Map<string, RendererEntry>();

function normalizeCodeBlockLanguage(language: string): string {
  return language.trim().toLowerCase();
}

function registerCodeBlockPreviewRenderer(renderer: CodeBlockPreviewRenderer): Disposer {
  if (!renderer.id.trim()) {
    throw new Error("Code block preview renderer id is required.");
  }

  const entry: RendererEntry = {
    renderer,
    sequence: nextSequence,
  };
  nextSequence += 1;
  rendererEntries.set(renderer.id, entry);

  return () => {
    if (rendererEntries.get(renderer.id) === entry) {
      rendererEntries.delete(renderer.id);
    }
  };
}

function resolveCodeBlockPreviewRenderer(language: string): CodeBlockPreviewRenderer | null {
  const normalized = normalizeCodeBlockLanguage(language);
  if (!normalized) return null;

  for (const entry of [...rendererEntries.values()].sort((a, b) => a.sequence - b.sequence)) {
    if (entry.renderer.matches(normalized)) {
      return entry.renderer;
    }
  }

  return null;
}

function listCodeBlockPreviewRenderers(): CodeBlockPreviewRenderer[] {
  return [...rendererEntries.values()]
    .sort((a, b) => a.sequence - b.sequence)
    .map((entry) => entry.renderer);
}

function clearCodeBlockPreviewRenderersForTest(): void {
  rendererEntries.clear();
  nextSequence = 0;
}

export {
  clearCodeBlockPreviewRenderersForTest,
  listCodeBlockPreviewRenderers,
  normalizeCodeBlockLanguage,
  registerCodeBlockPreviewRenderer,
  resolveCodeBlockPreviewRenderer,
};
export type {
  CodeBlockPreviewEstimateContext,
  CodeBlockPreviewRenderContext,
  CodeBlockPreviewRenderer,
};
