import { createStore } from "solid-js/store";

import { readFile } from "~/lib/vault_fs";
import { getActiveTab } from "~/stores/files";
import { vaultState } from "~/stores/vault";

import { callPluginSidecar } from "./installer";

type MemorySuggestionKind =
  | "rememberNote"
  | "extractInsight"
  | "suggestLink"
  | "timelineEntry"
  | "relatedMemory";

interface MemorySuggestion {
  id: string;
  kind: MemorySuggestionKind;
  slug: string;
  title: string;
  preview: string;
  confidence: number;
  payload: Record<string, unknown>;
  createdAt: string;
}

interface RelatedMemory {
  slug: string;
  title: string;
  reason: string;
  score: number;
}

interface KnowledgeStats {
  pages: number;
  timelineEntries: number;
  suggestions: number;
  insights: number;
}

interface HeldMemory {
  slug: string;
  title: string;
  path: string | null;
  heldAt: string;
}

type MemoryStatus = "off" | "ready" | "using" | "needsReview";

interface MemoryState {
  enabled: boolean;
  activeSlug: string;
  activePath: string | null;
  activeTitle: string;
  status: MemoryStatus;
  related: RelatedMemory[];
  suggestions: MemorySuggestion[];
  knowledgeStats: KnowledgeStats | null;
  heldMemory: HeldMemory | null;
  lastRememberedAt: string | null;
  loading: boolean;
  error: string | null;
}

const HELD_MEMORY_KEY = "kuku.gbrain.heldMemory.v1";
const ENABLED_KEY = "kuku.gbrain.enabled.v1";

function loadEnabled(): boolean {
  try {
    return globalThis.localStorage?.getItem(ENABLED_KEY) === "true";
  } catch {
    return false;
  }
}

function loadHeldMemory(): HeldMemory | null {
  try {
    const raw = globalThis.localStorage?.getItem(HELD_MEMORY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<HeldMemory>;
    if (!parsed.slug || !parsed.title) return null;
    return {
      slug: parsed.slug,
      title: parsed.title,
      path: parsed.path ?? null,
      heldAt: parsed.heldAt ?? new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

const [memoryState, setMemoryState] = createStore<MemoryState>({
  enabled: loadEnabled(),
  activeSlug: "",
  activePath: null,
  activeTitle: "",
  status: "off",
  related: [],
  suggestions: [],
  knowledgeStats: null,
  heldMemory: loadHeldMemory(),
  lastRememberedAt: null,
  loading: false,
  error: null,
});

function persistHeldMemory(memory: HeldMemory | null): void {
  try {
    if (memory) {
      globalThis.localStorage?.setItem(HELD_MEMORY_KEY, JSON.stringify(memory));
      return;
    }
    globalThis.localStorage?.removeItem(HELD_MEMORY_KEY);
  } catch {
    // Holding memory is a convenience layer; failing persistence should not block GBrain.
  }
}

function setGBrainEnabled(enabled: boolean): void {
  try {
    globalThis.localStorage?.setItem(ENABLED_KEY, enabled ? "true" : "false");
  } catch {
    // Non-critical UI preference.
  }
  setMemoryState("enabled", enabled);
  if (!enabled) {
    setMemoryState({
      status: "off",
      related: [],
      suggestions: [],
      loading: false,
      error: null,
    });
  }
}

function slugFromPath(path: string): string {
  const readable = path
    .replace(/\.[^/.]+$/, "")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  if (readable) return readable;

  let hash = 0;
  for (let index = 0; index < path.length; index += 1) {
    hash = (hash * 31 + path.charCodeAt(index)) >>> 0;
  }
  return `note-${hash.toString(36)}`;
}

function titleFromPath(path: string | null): string {
  if (!path) return "";
  return path.split("/").pop()?.replace(/\.md$/i, "") || path;
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function currentMemoryStatus(suggestions: MemorySuggestion[]): MemoryStatus {
  if (suggestions.length > 0) return "needsReview";
  return "ready";
}

async function refreshKnowledgeStats(): Promise<void> {
  const raw = await callPluginSidecar("gbrain", "gbrain", "doctor", {});
  const parsed = parseJson<Partial<KnowledgeStats>>(raw, {});
  setMemoryState("knowledgeStats", {
    pages: parsed.pages ?? 0,
    timelineEntries: parsed.timelineEntries ?? 0,
    suggestions: parsed.suggestions ?? 0,
    insights: parsed.insights ?? 0,
  });
}

async function refreshMemoryContext(): Promise<void> {
  const path = getActiveTab()?.filePath ?? null;
  const title = titleFromPath(path);
  if (!memoryState.enabled) {
    setMemoryState({
      activeSlug: path ? slugFromPath(path) : "",
      activePath: path,
      activeTitle: title,
      status: "off",
      related: [],
      suggestions: [],
      loading: false,
      error: null,
    });
    return;
  }

  if (!path) {
    await refreshKnowledgeStats().catch(() => {
      setMemoryState("knowledgeStats", null);
    });
    setMemoryState({
      activeSlug: "",
      activePath: null,
      activeTitle: "",
      status: "off",
      related: [],
      suggestions: [],
      loading: false,
      error: null,
    });
    return;
  }

  const slug = slugFromPath(path);
  setMemoryState({
    activeSlug: slug,
    activePath: path,
    activeTitle: title,
    status: "using",
    loading: true,
    error: null,
  });

  try {
    const content = await readFile(path);
    const [suggestionsRaw, relatedRaw] = await Promise.all([
      callPluginSidecar("gbrain", "gbrain", "analyzeNote", {
        slug,
        title,
        content,
        sourcePath: path,
      }),
      callPluginSidecar("gbrain", "gbrain", "listRelated", {
        slug,
        query: title,
      }),
      refreshKnowledgeStats(),
    ]);
    const suggestions = parseJson<MemorySuggestion[]>(suggestionsRaw, []);
    const related = parseJson<RelatedMemory[]>(relatedRaw, []);
    setMemoryState({
      suggestions,
      related,
      status: currentMemoryStatus(suggestions),
      loading: false,
      error: null,
    });
  } catch (error) {
    setMemoryState({
      status: "off",
      loading: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function rememberActiveNote(): Promise<boolean> {
  const path = getActiveTab()?.filePath ?? null;
  if (!path) return false;

  setGBrainEnabled(true);
  const slug = slugFromPath(path);
  const title = titleFromPath(path);
  const content = await readFile(path);
  await callPluginSidecar("gbrain", "gbrain", "putPage", {
    slug,
    content,
    sourcePath: path,
  });
  const heldMemory = {
    slug,
    title,
    path,
    heldAt: new Date().toISOString(),
  };
  persistHeldMemory(heldMemory);
  setMemoryState({
    activeSlug: slug,
    activePath: path,
    activeTitle: title,
    heldMemory,
    lastRememberedAt: heldMemory.heldAt,
  });
  await refreshMemoryContext();
  return true;
}

function clearHeldMemory(): void {
  persistHeldMemory(null);
  setMemoryState("heldMemory", null);
}

async function rememberVault(): Promise<number | null> {
  if (!vaultState.rootPath) return null;
  setGBrainEnabled(true);
  const output = await callPluginSidecar("gbrain", "gbrain", "importVault", {
    path: vaultState.rootPath,
  });
  const imported = parseJson<{ imported?: number }>(output, {}).imported ?? null;
  await refreshMemoryContext();
  return imported;
}

async function acceptMemorySuggestion(id: string): Promise<void> {
  await callPluginSidecar("gbrain", "gbrain", "acceptSuggestion", { id });
  await refreshMemoryContext();
}

async function dismissMemorySuggestion(id: string): Promise<void> {
  await callPluginSidecar("gbrain", "gbrain", "dismissSuggestion", { id });
  await refreshMemoryContext();
}

function memoryPrompt(request: string): string {
  if (!memoryState.enabled) return request;

  const currentContext = memoryState.activePath
    ? `Current note: ${memoryState.activePath}\nGBrain memory id: ${memoryState.activeSlug}`
    : "No note is currently open.";
  const heldContext = memoryState.heldMemory
    ? [
        `Held GBrain memory: ${memoryState.heldMemory.title}`,
        `Held memory id: ${memoryState.heldMemory.slug}`,
        memoryState.heldMemory.path ? `Held source: ${memoryState.heldMemory.path}` : "",
      ]
        .filter(Boolean)
        .join("\n")
    : "No GBrain memory is currently held.";

  return [
    "Use GBrain as the user's second-brain memory layer.",
    "Prefer read tools first: brain_query, brain_search, brain_list_related, brain_get_page, brain_backlinks, brain_graph, brain_timeline.",
    "In Ask and Inline, do not mutate memory. In Agent mode, propose memory writes only when the user explicitly asks to remember, connect, or record something.",
    "Treat held GBrain memory as the user's active working memory until they release it.",
    "When using memory, answer naturally in the user's language and mention remembered sources only when useful.",
    "",
    currentContext,
    heldContext,
    "",
    `User request: ${request}`,
  ].join("\n");
}

export {
  acceptMemorySuggestion,
  clearHeldMemory,
  dismissMemorySuggestion,
  memoryPrompt,
  memoryState,
  refreshKnowledgeStats,
  refreshMemoryContext,
  rememberActiveNote,
  rememberVault,
  setGBrainEnabled,
  slugFromPath,
  titleFromPath,
};
export type {
  HeldMemory,
  KnowledgeStats,
  MemoryState,
  MemoryStatus,
  MemorySuggestion,
  RelatedMemory,
};
