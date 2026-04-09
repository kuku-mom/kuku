import { createStore, produce } from "solid-js/store";

import type { PMNodeJSON } from "~/lib/markdown";
import { remapMovedPath } from "~/lib/vault_path";

interface DiffEntry {
  sourceFilePath: string;
  oldMarkdown: string;
  newMarkdown: string;
  diffDoc: PMNodeJSON;
}

interface DiffStoreState {
  entries: Record<string, DiffEntry>;
}

const DIFF_TAB_PREFIX = "diff://";

const [diffStoreState, setDiffStoreState] = createStore<DiffStoreState>({
  entries: {},
});

function createDiffTabPath(sourceFilePath: string): string {
  return `${DIFF_TAB_PREFIX}${sourceFilePath}`;
}

function isDiffTabPath(filePath: string | null | undefined): filePath is string {
  return typeof filePath === "string" && filePath.startsWith(DIFF_TAB_PREFIX);
}

function getSourceFilePathFromDiffPath(filePath: string | null | undefined): string | null {
  if (!isDiffTabPath(filePath)) {
    return null;
  }

  return filePath.slice(DIFF_TAB_PREFIX.length);
}

function registerDiff(
  sourceFilePath: string,
  oldMarkdown: string,
  newMarkdown: string,
  diffDoc: PMNodeJSON,
): string {
  const diffTabPath = createDiffTabPath(sourceFilePath);
  setDiffStoreState("entries", diffTabPath, {
    sourceFilePath,
    oldMarkdown,
    newMarkdown,
    diffDoc,
  });
  return diffTabPath;
}

function getDiffEntry(diffTabPath: string): DiffEntry | undefined {
  return diffStoreState.entries[diffTabPath];
}

function removeDiffEntry(diffTabPath: string): void {
  setDiffStoreState(
    "entries",
    produce((entries) => {
      delete entries[diffTabPath];
    }),
  );
}

function renameDiffEntriesMap(
  entries: Record<string, DiffEntry>,
  from: string,
  to: string,
  isDir: boolean,
): Record<string, DiffEntry> {
  let didChange = false;
  const nextEntries: Record<string, DiffEntry> = {};

  for (const entry of Object.values(entries)) {
    const nextSourceFilePath = remapMovedPath(entry.sourceFilePath, from, to, isDir);
    if (nextSourceFilePath !== entry.sourceFilePath) {
      didChange = true;
    }

    const nextEntry =
      nextSourceFilePath === entry.sourceFilePath
        ? entry
        : {
            ...entry,
            sourceFilePath: nextSourceFilePath,
          };

    nextEntries[createDiffTabPath(nextSourceFilePath)] = nextEntry;
  }

  return didChange ? nextEntries : entries;
}

function renameDiffEntriesForMovedPath(from: string, to: string, isDir: boolean): void {
  setDiffStoreState(
    produce((state) => {
      state.entries = renameDiffEntriesMap(state.entries, from, to, isDir);
    }),
  );
}

function resetDiffStore(): void {
  setDiffStoreState("entries", {});
}

export {
  createDiffTabPath,
  getDiffEntry,
  getSourceFilePathFromDiffPath,
  isDiffTabPath,
  registerDiff,
  resetDiffStore,
  renameDiffEntriesForMovedPath,
  renameDiffEntriesMap,
  removeDiffEntry,
};
export type { DiffEntry };
