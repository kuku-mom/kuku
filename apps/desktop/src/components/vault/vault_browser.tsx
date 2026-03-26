import { For, onMount, Show } from "solid-js";

import ScrollArea from "~/components/scroll_area";
import {
  ChevronIcon,
  FileIcon,
  FolderIcon,
  FolderPlusIcon,
  KukuLogoSmall,
  PlusIcon,
  SettingsIcon,
} from "~/components/icons";
import { type FileEntry } from "~/lib/vault_fs";
import { getContextKey } from "~/plugins/context_keys";
import { getActiveTab, openTab } from "~/stores/files";
import {
  cancelEdit,
  confirmEdit,
  isFolderExpanded,
  revealPath,
  setSelectedPath,
  startCreateFile,
  startCreateFolder,
  toggleFolder,
  updateEditName,
  vaultState,
} from "~/stores/vault";

type GuideType = "line" | "branch" | "corner" | "empty";

function TreeGuide(props: { type: GuideType }) {
  return (
    <span class="relative w-3.5 shrink-0 self-stretch">
      <Show when={props.type !== "empty"}>
        <span
          class="absolute left-1.75 w-px bg-text-muted/20"
          classList={{
            "inset-y-0": props.type === "line" || props.type === "branch",
            "top-0 h-1/2": props.type === "corner",
          }}
        />
      </Show>
      <Show when={props.type === "branch" || props.type === "corner"}>
        <span class="absolute top-1/2 left-1.75 h-px w-1.75 bg-text-muted/20" />
      </Show>
    </span>
  );
}

function InlineNameInput(props: { depth: number; guides: boolean[]; isLast: boolean }) {
  let inputRef: HTMLInputElement | undefined;

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void confirmEdit();
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      cancelEdit();
    }
  };

  onMount(() => inputRef?.focus());

  return (
    <div class="flex items-center py-0.75 pl-0.5 text-[0.8125rem] text-text-secondary">
      <For each={props.depth > 0 ? props.guides.slice(0, -1) : []}>
        {(active) => <TreeGuide type={active ? "line" : "empty"} />}
      </For>
      <Show when={props.depth > 0}>
        <TreeGuide type={props.isLast ? "corner" : "branch"} />
      </Show>

      <Show
        when={vaultState.editState?.isDir}
        fallback={
          <>
            <span class="w-3.5 shrink-0" />
            <span class="flex h-4.5 shrink-0 items-center">
              <FileIcon class="text-text-muted" />
            </span>
          </>
        }
      >
        <span class="flex h-4.5 w-3.5 shrink-0 items-center justify-center">
          <ChevronIcon size={12} />
        </span>
        <span class="flex h-4.5 shrink-0 items-center">
          <FolderIcon class="text-text-muted" />
        </span>
      </Show>

      <input
        ref={inputRef}
        class="ml-1 min-w-0 flex-1 rounded-sm border border-accent bg-bg-primary px-1 text-[0.8125rem]/4.5 text-text-primary outline-none"
        value={vaultState.editState?.name ?? ""}
        placeholder={vaultState.editState?.isDir ? "Folder name" : "File name"}
        onInput={(event) => updateEditName(event.currentTarget.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => void confirmEdit()}
      />
    </div>
  );
}

interface FileTreeNodeProps {
  entry: FileEntry;
  depth: number;
  isLast: boolean;
  guides: boolean[];
}

function FileTreeNode(props: FileTreeNodeProps) {
  const panelFocused = () => getContextKey<string | null>("focusZone") === "left";
  const expanded = () => isFolderExpanded(props.entry.path);
  const childGuides = () => [...props.guides, !props.isLast];
  const isSelected = () => vaultState.selectedPath === props.entry.path;
  const isActive = () => getActiveTab()?.filePath === props.entry.path;
  const showEditInput = () =>
    vaultState.editState !== null &&
    props.entry.is_directory &&
    expanded() &&
    vaultState.editState.parentPath === props.entry.path;

  const handleClick = () => {
    setSelectedPath(props.entry.path);
    if (props.entry.is_directory) {
      toggleFolder(props.entry.path);
      return;
    }

    revealPath(props.entry.path);
    openTab(props.entry.name, props.entry.path, "editor");
  };

  return (
    <>
      <button
        type="button"
        class="flex w-full items-center py-0.75 pl-0.5 text-left text-[0.8125rem] text-text-secondary select-none hover:bg-accent-dim"
        classList={{
          "bg-list-active! text-text-primary!": isSelected() && panelFocused(),
          "bg-list-inactive!": isActive() && !(isSelected() && panelFocused()),
        }}
        onClick={handleClick}
      >
        <For each={props.depth > 0 ? props.guides.slice(0, -1) : []}>
          {(active) => <TreeGuide type={active ? "line" : "empty"} />}
        </For>
        <Show when={props.depth > 0}>
          <TreeGuide type={props.isLast ? "corner" : "branch"} />
        </Show>

        <Show
          when={props.entry.is_directory}
          fallback={
            <>
              <span class="w-3.5 shrink-0" />
              <span class="flex h-4.5 shrink-0 items-center">
                <FileIcon class="text-text-muted" />
              </span>
            </>
          }
        >
          <span
            class="flex h-4.5 w-3.5 shrink-0 items-center justify-center transition-transform"
            classList={{ "rotate-90": expanded() }}
          >
            <ChevronIcon size={12} />
          </span>
          <span class="flex h-4.5 shrink-0 items-center">
            <FolderIcon class="text-text-muted" />
          </span>
        </Show>

        <span class="pointer-events-none ml-1 truncate leading-4.5">{props.entry.name}</span>
      </button>

      <Show when={props.entry.is_directory && expanded()}>
        <Show when={showEditInput()}>
          <InlineNameInput
            depth={props.depth + 1}
            guides={childGuides()}
            isLast={!props.entry.children?.length}
          />
        </Show>
        <For each={props.entry.children ?? []}>
          {(child, index) => (
            <FileTreeNode
              entry={child}
              depth={props.depth + 1}
              isLast={index() === (props.entry.children?.length ?? 0) - 1}
              guides={childGuides()}
            />
          )}
        </For>
      </Show>
    </>
  );
}

function EmptyVaultState() {
  const status = () =>
    vaultState.configuredVaultStatus ?? {
      kind: "none" as const,
      path: null,
      message: null,
    };
  const title = () => {
    switch (status().kind) {
      case "missing":
        return "Vault not found";
      case "unavailable":
        return "Vault unavailable";
      default:
        return "No vault configured";
    }
  };
  const description = () => {
    switch (status().kind) {
      case "missing":
        return "The saved vault folder could not be found. Choose a new folder in Settings.";
      case "unavailable":
        return "The saved vault folder could not be opened. Check the path in Settings.";
      default:
        return "Choose your vault folder in Settings to start browsing files.";
    }
  };

  return (
    <div class="flex min-h-0 flex-1 items-center justify-center px-4 py-6">
      <div class="flex w-full max-w-62 flex-col gap-3 rounded-xl border border-border bg-bg-primary p-4 text-center">
        <div class="space-y-1">
          <p class="text-sm font-medium text-text-primary">{title()}</p>
          <p class="text-xs/5 text-text-secondary">{description()}</p>
        </div>

        <Show when={status().path}>
          {(path) => (
            <div class="rounded-md border border-border bg-bg-secondary px-2.5 py-2 text-left font-mono text-[0.6875rem]/4 break-all text-text-muted">
              {path()}
            </div>
          )}
        </Show>

        <Show when={status().kind === "unavailable" && status().message}>
          {(message) => <p class="text-[0.6875rem]/4 text-text-muted">{message()}</p>}
        </Show>

        <button
          type="button"
          class="rounded-md border border-border px-3 py-2 text-sm text-text-secondary transition-colors hover:bg-ghost-hover hover:text-text-primary"
          onClick={() => openTab("Settings", null, "settings")}
        >
          Open Settings
        </button>
      </div>
    </div>
  );
}

function handleEmptySpaceClick(event: MouseEvent) {
  if (event.target === event.currentTarget) {
    setSelectedPath(null);
  }
}

export default function VaultBrowser() {
  const showRootEditInput = () =>
    vaultState.editState !== null && vaultState.editState.parentPath === "";

  return (
    <div class="flex h-full min-h-0 flex-col overflow-hidden">
      <div class="flex items-center justify-between px-3 py-2">
        <Show
          when={vaultState.rootPath}
          fallback={
            <span class="text-xs font-semibold tracking-[0.16em] text-text-muted uppercase">
              Explorer
            </span>
          }
        >
          <KukuLogoSmall size={64} class="shrink-0" />
          <div class="flex items-center gap-2">
            <button
              type="button"
              class="rounded-sm p-1 text-text-muted transition-colors hover:bg-accent-dim hover:text-text-secondary"
              title="New Folder"
              onClick={startCreateFolder}
            >
              <FolderPlusIcon size={16} />
            </button>
            <button
              type="button"
              class="rounded-sm p-1 text-text-muted transition-colors hover:bg-accent-dim hover:text-text-secondary"
              title="New File"
              onClick={startCreateFile}
            >
              <PlusIcon size={16} />
            </button>
          </div>
        </Show>
      </div>

      <Show when={vaultState.rootPath} fallback={<EmptyVaultState />}>
        <ScrollArea class="flex-1 px-1" axis="y" onClick={handleEmptySpaceClick}>
          <Show
            when={showRootEditInput() || vaultState.files.length > 0}
            fallback={
              <p class="px-2 py-8 text-center text-xs text-text-muted">This vault is empty.</p>
            }
          >
            <Show when={showRootEditInput()}>
              <InlineNameInput depth={0} guides={[]} isLast={vaultState.files.length === 0} />
            </Show>
            <For each={vaultState.files}>
              {(entry, index) => (
                <FileTreeNode
                  entry={entry}
                  depth={0}
                  isLast={index() === vaultState.files.length - 1}
                  guides={[]}
                />
              )}
            </For>
          </Show>
        </ScrollArea>
      </Show>

      <div class="flex items-center border-t border-border px-3 py-2">
        <button
          type="button"
          class="flex items-center gap-2 rounded-md px-2 py-1 text-xs text-text-muted transition-colors hover:bg-accent-dim hover:text-text-secondary"
          onClick={() => openTab("Settings", null, "settings")}
          title="Settings"
        >
          <SettingsIcon size={14} />
          <span>Settings</span>
        </button>
      </div>
    </div>
  );
}
