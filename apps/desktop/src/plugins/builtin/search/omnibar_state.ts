import { createSignal, onCleanup } from "solid-js";

import { t } from "~/i18n";
import { getSearchService } from "./runtime";
import {
  getRegexCaseSensitive,
  getSearchMode,
  setRegexCaseSensitive,
  setSearchMode,
  type SearchMode,
} from "./search_mode_state";
import type { SearchService } from "../core_indexer/service";
import type { SimpleSearchHit, SimpleSearchResult } from "../core_indexer/types";

interface OmnibarController {
  mode: () => SearchMode;
  caseSensitive: () => boolean;
  query: () => string;
  results: () => SimpleSearchResult | null;
  isLoading: () => boolean;
  error: () => string | null;
  selectedIndex: () => number;
  setMode(nextMode: SearchMode): void;
  setCaseSensitive(nextValue: boolean): void;
  scheduleSearch(nextQuery: string): void;
  moveSelection(delta: number): void;
  setSelectedIndex(index: number): void;
  selectCurrent(): SimpleSearchHit | null;
}

const [isSearchOmnibarOpen, setSearchOmnibarOpen] = createSignal(false);

function openSearchOmnibar(mode: SearchMode = "simple"): void {
  setSearchMode(mode);
  setSearchOmnibarOpen(true);
}

function closeSearchOmnibar(): void {
  setSearchOmnibarOpen(false);
}

function resetSearchOmnibarState(): void {
  setSearchOmnibarOpen(false);
}

function createOmnibarController(
  serviceAccessor: () => SearchService | null = getSearchService,
): OmnibarController {
  const [query, setQuery] = createSignal("");
  const [results, setResults] = createSignal<SimpleSearchResult | null>(null);
  const [isLoading, setIsLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [selectedIndex, setSelectedIndex] = createSignal(-1);

  let sequenceId = 0;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  };

  const executeSearch = async (nextQuery: string) => {
    const trimmed = nextQuery.trim();
    const currentId = ++sequenceId;
    const service = serviceAccessor();

    if (!trimmed) {
      setResults(null);
      setError(null);
      setIsLoading(false);
      setSelectedIndex(-1);
      return;
    }

    if (!service) {
      setResults(null);
      setError(t("search.error.unavailable"));
      setIsLoading(false);
      setSelectedIndex(-1);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const res =
        getSearchMode() === "regex"
          ? await service.queryAdvanced({
              query: trimmed,
              caseSensitive: getRegexCaseSensitive(),
            })
          : await service.querySimple(trimmed);
      if (currentId !== sequenceId) return;
      setResults(res);
      setSelectedIndex(res.items.length > 0 ? 0 : -1);
      setIsLoading(false);
    } catch (caughtError) {
      if (currentId !== sequenceId) return;
      setResults(null);
      setSelectedIndex(-1);
      setError(caughtError instanceof Error ? caughtError.message : t("search.error.failed"));
      setIsLoading(false);
    }
  };

  const scheduleSearch = (nextQuery: string) => {
    setQuery(nextQuery);
    clearTimer();

    if (!nextQuery.trim()) {
      sequenceId += 1;
      setResults(null);
      setError(null);
      setIsLoading(false);
      setSelectedIndex(-1);
      return;
    }

    debounceTimer = setTimeout(() => {
      void executeSearch(nextQuery);
    }, 250);
  };

  const moveSelection = (delta: number) => {
    const items = results()?.items ?? [];
    if (items.length === 0) return;
    const nextIndex = selectedIndex() < 0 ? 0 : selectedIndex() + delta;
    setSelectedIndex(Math.max(0, Math.min(items.length - 1, nextIndex)));
  };

  const selectCurrent = () => {
    const items = results()?.items ?? [];
    const index = selectedIndex();
    if (index < 0 || index >= items.length) {
      return null;
    }
    return items[index];
  };

  const rerunCurrentQuery = () => {
    scheduleSearch(query());
  };

  const setMode = (nextMode: SearchMode) => {
    if (getSearchMode() === nextMode) return;
    setSearchMode(nextMode);
    rerunCurrentQuery();
  };

  const setCaseSensitive = (nextValue: boolean) => {
    if (getRegexCaseSensitive() === nextValue) return;
    setRegexCaseSensitive(nextValue);
    if (getSearchMode() === "regex") {
      rerunCurrentQuery();
    }
  };

  onCleanup(clearTimer);

  return {
    mode: getSearchMode,
    caseSensitive: getRegexCaseSensitive,
    query,
    results,
    isLoading,
    error,
    selectedIndex,
    setMode,
    setCaseSensitive,
    scheduleSearch,
    moveSelection,
    setSelectedIndex,
    selectCurrent,
  };
}

export {
  closeSearchOmnibar,
  createOmnibarController,
  isSearchOmnibarOpen,
  openSearchOmnibar,
  resetSearchOmnibarState,
};
export type { OmnibarController };
