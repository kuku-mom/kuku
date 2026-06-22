import type { FileEntry } from "~/lib/vault_fs";

import type {
  ChatConversationScope,
  ChatScopeMessageAttachment,
  FolderScopeOption,
  FolderScopeSnapshot,
} from "./types";

const STANDARD_FILES = ["PROJECT.md", "NEXT.md", "AGENTS.md"] satisfies readonly string[];
const MEMORY_DIRS = {
  decisions: "Decisions",
  meetings: "Meetings",
  proposals: "Proposals",
} satisfies Record<string, string>;

const VAULT_SCOPE: ChatConversationScope = { kind: "vault" };

function isRootFolderEntry(entry: FileEntry): boolean {
  return entry.is_directory && entry.path.length > 0 && !entry.path.includes("/");
}

function normalizeConversationScope(scope: ChatConversationScope): ChatConversationScope {
  if (scope.kind === "vault") return VAULT_SCOPE;
  const folder = scope.folder.trim();
  return folder.length > 0 ? { kind: "folder", folder } : VAULT_SCOPE;
}

function getFolderScopeOptions(entries: readonly FileEntry[]): FolderScopeOption[] {
  return entries.filter(isRootFolderEntry).map((entry) => ({
    folder: entry.path,
    label: entry.name,
    missingFiles: missingStandardFiles(entry),
  }));
}

function getFolderProjectSnapshot(
  entries: readonly FileEntry[],
  folder: string,
): FolderScopeSnapshot | null {
  const entry = entries.find((item) => item.path === folder && isRootFolderEntry(item));
  if (!entry) return null;
  const missingFiles = missingStandardFiles(entry);
  const presentFiles = STANDARD_FILES.filter((name) => !missingFiles.includes(name));
  return {
    folder: entry.path,
    presentFiles,
    missingFiles,
    decisionCount: countMarkdownFiles(childDirectory(entry, MEMORY_DIRS.decisions)),
    meetingCount: countMarkdownFiles(childDirectory(entry, MEMORY_DIRS.meetings)),
    proposalCount: countMarkdownFiles(childDirectory(entry, MEMORY_DIRS.proposals)),
  };
}

function projectFolderForScope(scope: ChatConversationScope): string | null {
  return scope.kind === "folder" ? scope.folder : null;
}

function scopeMessageAttachment(
  scope: ChatConversationScope,
): ChatScopeMessageAttachment | null {
  if (scope.kind === "vault") return null;
  return {
    kind: "scope",
    scope: "folder",
    folder: scope.folder,
    label: `Folder: ${scope.folder}`,
  };
}

function scopeTitle(scope: ChatConversationScope): string {
  return scope.kind === "folder" ? `Folder: ${scope.folder}` : "Vault";
}

function folderHasMissingSetup(entry: FileEntry): boolean {
  return missingStandardFiles(entry).length > 0;
}

function missingStandardFiles(entry: FileEntry): string[] {
  return STANDARD_FILES.filter((name) => !directFile(entry, name));
}

function directFile(entry: FileEntry, name: string): boolean {
  return (entry.children ?? []).some((child) => !child.is_directory && child.name === name);
}

function childDirectory(entry: FileEntry, name: string): FileEntry | null {
  return (
    (entry.children ?? []).find((child) => child.is_directory && child.name === name) ?? null
  );
}

function countMarkdownFiles(entry: FileEntry | null): number {
  if (!entry) return 0;
  return (entry.children ?? []).reduce((count, child) => {
    if (child.is_directory) return count + countMarkdownFiles(child);
    return child.name.toLowerCase().endsWith(".md") ? count + 1 : count;
  }, 0);
}

export {
  STANDARD_FILES,
  VAULT_SCOPE,
  folderHasMissingSetup,
  getFolderProjectSnapshot,
  getFolderScopeOptions,
  isRootFolderEntry,
  normalizeConversationScope,
  projectFolderForScope,
  scopeMessageAttachment,
  scopeTitle,
};
