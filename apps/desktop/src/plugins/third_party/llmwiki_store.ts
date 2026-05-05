import { createStore } from "solid-js/store";

import { readFile } from "~/lib/vault_fs";
import { getActiveTab } from "~/stores/files";
import { loadFiles, vaultState } from "~/stores/vault";

import { callPluginSidecar } from "./installer";

interface WikiStatus {
  ok?: boolean;
  pages: number;
  sources: number;
  links: number;
  orphans: number;
  concepts?: number;
  entities?: number;
  synthesis?: number;
  home?: string;
  rawPath?: string;
  wikiPath?: string;
  schemaPath?: string;
}

interface WikiPage {
  path: string;
  slug: string;
  title: string;
  links: string[];
  bytes: number;
  updatedAt: string;
}

interface WikiSearchMatch {
  path: string;
  slug: string;
  title: string;
  score: number;
  excerpt: string;
}

interface WikiConcept {
  concept: string;
  count: number;
}

interface WikiSparsePage {
  path: string;
  title: string;
  bytes: number;
}

interface WikiSynthesisCandidate {
  title: string;
  targetPath: string;
  reason: string;
}

interface WikiReview {
  topConcepts: WikiConcept[];
  sparsePages: WikiSparsePage[];
  synthesisCandidates: WikiSynthesisCandidate[];
  questions: string[];
  lint?: {
    brokenLinks?: { from: string; to: string }[];
    orphans?: string[];
  };
}

interface WikiState {
  initialized: boolean;
  loading: boolean;
  error: string | null;
  status: WikiStatus | null;
  pages: WikiPage[];
  matches: WikiSearchMatch[];
  review: WikiReview | null;
  lastIngestedPath: string | null;
}

const [wikiState, setWikiState] = createStore<WikiState>({
  initialized: false,
  loading: false,
  error: null,
  status: null,
  pages: [],
  matches: [],
  review: null,
  lastIngestedPath: null,
});

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function titleFromPath(path: string | null): string {
  if (!path) return "";
  return path.split("/").pop()?.replace(/\.md$/i, "") || path;
}

function sidecarParams(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...extra,
    vaultPath: vaultState.rootPath,
  };
}

async function refreshVaultTree(): Promise<void> {
  if (!vaultState.rootPath) return;
  await loadFiles(vaultState.rootPath);
}

async function initWiki(): Promise<void> {
  setWikiState({ loading: true, error: null });
  try {
    if (!vaultState.rootPath) throw new Error("open_vault_first");
    await callPluginSidecar("llmwiki", "llmwiki", "init", sidecarParams());
    await refreshVaultTree();
    await refreshWiki();
  } catch (error) {
    setWikiState("error", error instanceof Error ? error.message : String(error));
  } finally {
    setWikiState("loading", false);
  }
}

async function refreshWiki(): Promise<void> {
  if (!vaultState.rootPath) {
    setWikiState({
      initialized: false,
      loading: false,
      error: null,
      status: null,
      pages: [],
      matches: [],
      review: null,
    });
    return;
  }

  setWikiState({ loading: true, error: null });
  try {
    if (!vaultState.rootPath) throw new Error("open_vault_first");
    const [statusRaw, pagesRaw] = await Promise.all([
      callPluginSidecar("llmwiki", "llmwiki", "status", sidecarParams()),
      callPluginSidecar("llmwiki", "llmwiki", "listPages", sidecarParams()),
    ]);
    const status = parseJson<WikiStatus | null>(statusRaw, null);
    const pages = parseJson<WikiPage[]>(pagesRaw, []);
    const initialized = status?.ok === true;
    setWikiState({
      initialized,
      status,
      pages: initialized ? pages : [],
      loading: false,
      error: null,
    });
  } catch (error) {
    setWikiState({
      initialized: false,
      loading: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function ingestActiveNote(): Promise<boolean> {
  const path = getActiveTab()?.filePath ?? null;
  if (!path) return false;
  setWikiState({ loading: true, error: null });
  try {
    if (!vaultState.rootPath) throw new Error("open_vault_first");
    await callPluginSidecar(
      "llmwiki",
      "llmwiki",
      "ingestSource",
      sidecarParams({
        title: titleFromPath(path),
        content: await readFile(path),
        sourcePath: path,
      }),
    );
    setWikiState("lastIngestedPath", path);
    await refreshVaultTree();
    await refreshWiki();
    return true;
  } catch (error) {
    setWikiState({
      loading: false,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

async function searchWiki(query: string): Promise<WikiSearchMatch[]> {
  const trimmed = query.trim();
  if (!trimmed) {
    setWikiState("matches", []);
    return [];
  }
  setWikiState({ loading: true, error: null });
  try {
    const raw = await callPluginSidecar(
      "llmwiki",
      "llmwiki",
      "search",
      sidecarParams({ query: trimmed }),
    );
    const matches = parseJson<WikiSearchMatch[]>(raw, []);
    setWikiState({ matches, loading: false, error: null });
    return matches;
  } catch (error) {
    setWikiState({
      loading: false,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

async function queryWikiContext(query: string): Promise<string> {
  return callPluginSidecar("llmwiki", "llmwiki", "queryContext", sidecarParams({ query }));
}

async function lintWiki(): Promise<string> {
  return callPluginSidecar("llmwiki", "llmwiki", "lint", sidecarParams());
}

async function analyzeWiki(): Promise<WikiReview | null> {
  setWikiState({ loading: true, error: null });
  try {
    const raw = await callPluginSidecar("llmwiki", "llmwiki", "analyzeCorpus", sidecarParams());
    const review = parseJson<WikiReview | null>(raw, null);
    setWikiState({ review, loading: false, error: null });
    return review;
  } catch (error) {
    setWikiState({
      loading: false,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export {
  analyzeWiki,
  ingestActiveNote,
  initWiki,
  lintWiki,
  queryWikiContext,
  refreshWiki,
  searchWiki,
  titleFromPath,
  wikiState,
};
export type {
  WikiConcept,
  WikiPage,
  WikiReview,
  WikiSearchMatch,
  WikiState,
  WikiStatus,
  WikiSynthesisCandidate,
};
