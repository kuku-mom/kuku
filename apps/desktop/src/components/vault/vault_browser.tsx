import { For, Show } from "solid-js";

import { openTab } from "~/stores/files";
import {
  cancelEdit,
  closeVault,
  confirmEdit,
  isFolderExpanded,
  openVault,
  revealPath,
  setSelectedPath,
  startCreateFile,
  startCreateFolder,
  toggleFolder,
  updateEditName,
  vaultState,
} from "~/stores/vault";
import { chooseVaultDirectory, type FileEntry } from "~/lib/vault_fs";

function VaultBrowser() {
  function getEntryGlyph(entry: FileEntry): string {
    if (!entry.is_directory) return "•";
    return isFolderExpanded(entry.path) ? "▾" : "▸";
  }

  const handleOpenVault = async () => {
    const selected = await chooseVaultDirectory();
    if (!selected) return;
    await openVault(selected);
  };

  const renderEntries = (entries: FileEntry[]) => (
    <div class="space-y-0.5">
      <For each={entries}>
        {(entry) => (
          <div class="select-none">
            <button
              type="button"
              classList={{
                "bg-ghost-hover text-text-primary": vaultState.selectedPath === entry.path,
                "text-text-secondary": vaultState.selectedPath !== entry.path,
              }}
              class="flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left text-sm transition-colors hover:bg-ghost-hover"
              onClick={() => {
                setSelectedPath(entry.path);
                if (entry.is_directory) {
                  toggleFolder(entry.path);
                  revealPath(entry.path);
                  return;
                }
                revealPath(entry.path);
                openTab(entry.name, entry.path, "editor");
              }}
            >
              <span class="w-4 text-center text-[0.625rem] opacity-70">{getEntryGlyph(entry)}</span>
              <span class="truncate">{entry.name}</span>
            </button>

            <Show when={entry.is_directory && isFolderExpanded(entry.path)}>
              <div class="ml-4 border-l border-border pl-2">
                {renderEntries(entry.children ?? [])}
              </div>
            </Show>
          </div>
        )}
      </For>
    </div>
  );

  return (
    <div class="flex h-full min-h-0 flex-col gap-3 overflow-hidden p-3">
      <Show
        when={vaultState.rootPath}
        fallback={
          <div class="flex h-full flex-col items-center justify-center gap-3 rounded-xl border border-border bg-bg-primary p-4 text-center">
            <p class="text-sm text-text-secondary">Open a vault to start working.</p>
            <button
              type="button"
              class="rounded-lg bg-bg-elevated px-4 py-2 text-sm text-text-primary transition-colors hover:bg-bg-tertiary"
              onClick={() => void handleOpenVault()}
            >
              Open Vault
            </button>
          </div>
        }
      >
        <div class="flex items-center justify-between gap-2">
          <div class="min-w-0">
            <p class="truncate text-sm font-semibold text-text-primary">{vaultState.rootName}</p>
            <p class="truncate text-[0.6875rem] text-text-muted">{vaultState.rootPath}</p>
          </div>
          <button
            type="button"
            class="rounded-md border border-border px-2 py-1 text-xs text-text-secondary transition-colors hover:bg-ghost-hover"
            onClick={() => void closeVault()}
          >
            Close
          </button>
        </div>

        <div class="flex gap-2">
          <button
            type="button"
            class="rounded-md bg-bg-elevated px-2 py-1 text-xs text-text-primary transition-colors hover:bg-bg-tertiary"
            onClick={() => startCreateFile()}
          >
            New File
          </button>
          <button
            type="button"
            class="rounded-md bg-bg-elevated px-2 py-1 text-xs text-text-primary transition-colors hover:bg-bg-tertiary"
            onClick={() => startCreateFolder()}
          >
            New Folder
          </button>
        </div>

        <Show when={vaultState.editState}>
          {(editState) => (
            <div class="rounded-lg border border-border bg-bg-primary p-3">
              <p class="mb-2 text-xs text-text-muted">
                Creating in{" "}
                <span class="font-medium text-text-secondary">
                  {editState().parentPath || "root"}
                </span>
              </p>
              <div class="flex gap-2">
                <input
                  autofocus
                  value={editState().name}
                  class="min-w-0 flex-1 rounded-md border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary outline-none"
                  placeholder={editState().isDir ? "Folder name" : "File name"}
                  onInput={(event) => updateEditName(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      void confirmEdit();
                    } else if (event.key === "Escape") {
                      cancelEdit();
                    }
                  }}
                />
                <button
                  type="button"
                  class="rounded-md bg-accent px-3 py-2 text-sm text-bg-primary"
                  onClick={() => void confirmEdit()}
                >
                  Create
                </button>
                <button
                  type="button"
                  class="rounded-md border border-border px-3 py-2 text-sm text-text-secondary"
                  onClick={cancelEdit}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </Show>

        <div class="min-h-0 flex-1 overflow-y-auto rounded-xl border border-border bg-bg-secondary p-2">
          {renderEntries(vaultState.files)}
        </div>

        <p class="text-[0.6875rem] text-text-muted">
          {vaultState.isWatching ? "Watching for file changes" : "Watcher inactive"}
        </p>
      </Show>
    </div>
  );
}

export default VaultBrowser;
