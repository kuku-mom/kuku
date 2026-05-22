import { batch, createSignal, For, onCleanup, onMount, Show } from "solid-js";

import { openSearchOmnibar } from "~/plugins/builtin/search/omnibar_state";
import { addFileAttachment } from "~/plugins/builtin/ai_chat/chat_store";

import ScrollArea from "~/components/scroll_area";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "~/components/ui";
import {
  ChevronIcon,
  FileIcon,
  FolderIcon,
  FolderPlusIcon,
  KukuLogoSmall,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
} from "~/components/icons";
import TypingIndicator from "~/components/vault/typing_indicator";
import {
  getVaultSidebarFooterActionIds,
  getVaultSidebarFooterVaultLabel,
} from "~/components/vault/vault_sidebar_actions";
import { createVaultEntryDragPayload, type VaultEntryDragPayload } from "~/lib/vault_drag";
import { type FileEntry } from "~/lib/vault_fs";
import { getParentPath } from "~/lib/vault_path";
import { getContextKey } from "~/plugins/context_keys";
import { getActiveTab, openSettings } from "~/stores/files";
import {
  canMoveEntryToFolder,
  cancelEdit,
  confirmEdit,
  createDemoVaultSamples,
  deleteEntry,
  findInTree,
  isFolderExpanded,
  moveEntryToFolder,
  openVaultEntry,
  setSelectedPath,
  selectVault,
  startCreateFile,
  startCreateFolder,
  startRename,
  updateEditName,
  vaultState,
  type EditState,
} from "~/stores/vault";
import {
  clearVaultDrag,
  setVaultDragChatDropActive,
  startVaultDrag,
  updateVaultDragPointer,
  vaultDragState,
} from "~/stores/vault_drag";
import { t } from "~/i18n";

type GuideType = "line" | "branch" | "corner" | "empty";
const ROOT_DROP_TARGET = "__root__";
const DRAG_THRESHOLD_PX = 4;

function DropLine() {
  return (
    <span class="pointer-events-none absolute right-2 bottom-0 left-3.5 z-10 h-0.5 rounded-[0.0625rem] bg-accent/70">
      <span class="absolute top-1/2 -left-1 size-1.5 -translate-y-1/2 rounded-full bg-accent/70" />
    </span>
  );
}

function DragPreview() {
  return (
    <Show when={vaultDragState.isDragging && vaultDragState.payload}>
      {(payload) => (
        <div
          class="pointer-events-none fixed z-1100 inline-flex max-w-64 items-center gap-2 rounded-xs border border-border bg-bg-elevated/96 px-2.5 py-1.5 text-xs text-text-primary shadow-popover"
          style={{
            left: `${vaultDragState.mouseX + 14}px`,
            top: `${vaultDragState.mouseY + 14}px`,
          }}
        >
          <Show
            when={payload().isDirectory}
            fallback={<FileIcon class="shrink-0 text-text-muted" />}
          >
            <FolderIcon class="shrink-0 text-text-muted" />
          </Show>
          <span class="truncate">{payload().name}</span>
        </div>
      )}
    </Show>
  );
}

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

function TreeRowLeadingIcons(props: { isDir: boolean; expanded?: boolean }) {
  return (
    <Show
      when={props.isDir}
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
        classList={{ "rotate-90": props.expanded === true }}
      >
        <ChevronIcon size={12} />
      </span>
      <span class="flex h-4.5 shrink-0 items-center">
        <FolderIcon class="text-text-muted" />
      </span>
    </Show>
  );
}

function InlineNameInput(props: {
  editState: EditState;
  depth: number;
  guides: boolean[];
  isLast: boolean;
  expanded?: boolean;
}) {
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

      <TreeRowLeadingIcons isDir={props.editState.isDir} expanded={props.expanded} />

      <input
        ref={inputRef}
        class="ml-1 min-w-0 flex-1 rounded-xs border border-accent bg-bg-primary px-1 text-[0.8125rem]/4.5 text-text-primary outline-none"
        value={props.editState.name}
        placeholder={
          props.editState.isDir ? t("vault.input.folder_name") : t("vault.input.file_name")
        }
        onInput={(event) => updateEditName(event.currentTarget.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => void confirmEdit()}
        onClick={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
      />
    </div>
  );
}

interface FileTreeNodeProps {
  entry: FileEntry;
  depth: number;
  isLast: boolean;
  guides: boolean[];
  draggingPath: () => string | null;
  dropIndicatorPath: () => string | null;
  onEntryMouseDown: (entry: FileEntry, event: MouseEvent) => void;
  shouldSuppressClick: () => boolean;
}

function FileTreeNode(props: FileTreeNodeProps) {
  let nameClickTimer: ReturnType<typeof setTimeout> | null = null;
  const panelFocused = () => getContextKey("focusZone") === "left";
  const expanded = () => isFolderExpanded(props.entry.path);
  const childGuides = () => [...props.guides, !props.isLast];
  const isSelected = () => vaultState.selectedPath === props.entry.path;
  const isActive = () => getActiveTab()?.filePath === props.entry.path;
  const isDragSource = () => props.draggingPath() === props.entry.path;
  const isDropIndicator = () => props.dropIndicatorPath() === props.entry.path;
  const showInsideHighlight = () => isDropIndicator() && props.entry.is_directory;
  const showDropLine = () => isDropIndicator() && !props.entry.is_directory;
  const [contextMenuOpen, setContextMenuOpen] = createSignal(false);
  const rowEditState = () =>
    vaultState.editState?.kind === "rename" &&
    vaultState.editState.surface === "browser" &&
    vaultState.editState.targetPath === props.entry.path
      ? vaultState.editState
      : null;
  const childCreateEditState = () =>
    vaultState.editState?.kind === "create" &&
    props.entry.is_directory &&
    expanded() &&
    vaultState.editState.parentPath === props.entry.path
      ? vaultState.editState
      : null;

  const rowButtonClass =
    "relative flex w-full items-center py-0.75 pl-0.5 text-left text-[0.8125rem] text-text-secondary select-none hover:bg-accent-dim";

  const handleClick = () => {
    if (props.shouldSuppressClick()) return;
    void openVaultEntry(props.entry);
  };

  const handleRename = () => {
    startRename(props.entry.path, "browser");
  };

  const handleDelete = () => {
    void deleteEntry(props.entry.path);
  };

  const handleNameClick = (event: MouseEvent) => {
    event.stopPropagation();
    if (props.shouldSuppressClick()) return;

    if (nameClickTimer) {
      clearTimeout(nameClickTimer);
      nameClickTimer = null;
      event.preventDefault();
      handleRename();
      return;
    }

    nameClickTimer = setTimeout(() => {
      nameClickTimer = null;
      handleClick();
    }, 200);
  };

  onCleanup(() => {
    if (!nameClickTimer) return;
    clearTimeout(nameClickTimer);
    nameClickTimer = null;
  });

  const handleMouseDown = (event: MouseEvent) => {
    if (nameClickTimer) {
      clearTimeout(nameClickTimer);
      nameClickTimer = null;
    }
    props.onEntryMouseDown(props.entry, event);
  };

  return (
    <>
      <Show
        when={rowEditState()}
        fallback={
          <ContextMenu
            onOpenChange={(open) => {
              setContextMenuOpen(open);
              if (open) setSelectedPath(props.entry.path);
            }}
          >
            <ContextMenuTrigger>
              <button
                type="button"
                class={rowButtonClass}
                classList={{
                  "bg-list-active! text-text-primary!":
                    isSelected() && (panelFocused() || contextMenuOpen()),
                  "bg-list-inactive!":
                    isActive() && !(isSelected() && (panelFocused() || contextMenuOpen())),
                  "bg-accent-dim/70 text-text-primary! ring-1 ring-accent/60":
                    showInsideHighlight(),
                  "opacity-60": isDragSource(),
                }}
                data-vault-drop-path={props.entry.path}
                data-vault-drop-kind={props.entry.is_directory ? "directory" : "file"}
                onClick={handleClick}
                onMouseDown={handleMouseDown}
              >
                <Show when={showDropLine()}>
                  <DropLine />
                </Show>
                <For each={props.depth > 0 ? props.guides.slice(0, -1) : []}>
                  {(active) => <TreeGuide type={active ? "line" : "empty"} />}
                </For>
                <Show when={props.depth > 0}>
                  <TreeGuide type={props.isLast ? "corner" : "branch"} />
                </Show>

                <TreeRowLeadingIcons isDir={props.entry.is_directory} expanded={expanded()} />

                <span class="ml-1 truncate leading-4.5" onClick={handleNameClick}>
                  {props.entry.name}
                </span>
              </button>
            </ContextMenuTrigger>

            <ContextMenuContent>
              <ContextMenuItem label={t("vault.context.rename")} onSelect={handleRename} />
              <ContextMenuItem label={t("vault.context.delete")} danger onSelect={handleDelete} />
            </ContextMenuContent>
          </ContextMenu>
        }
      >
        {(editState) => (
          <InlineNameInput
            editState={editState()}
            depth={props.depth}
            guides={props.guides}
            isLast={props.isLast}
            expanded={expanded()}
          />
        )}
      </Show>

      <Show when={props.entry.is_directory && expanded()}>
        <Show when={childCreateEditState()}>
          {(editState) => (
            <InlineNameInput
              editState={editState()}
              depth={props.depth + 1}
              guides={childGuides()}
              isLast={!props.entry.children?.length}
            />
          )}
        </Show>
        <For each={props.entry.children ?? []}>
          {(child, index) => (
            <FileTreeNode
              entry={child}
              depth={props.depth + 1}
              isLast={index() === (props.entry.children?.length ?? 0) - 1}
              guides={childGuides()}
              draggingPath={props.draggingPath}
              dropIndicatorPath={props.dropIndicatorPath}
              onEntryMouseDown={props.onEntryMouseDown}
              shouldSuppressClick={props.shouldSuppressClick}
            />
          )}
        </For>
      </Show>
    </>
  );
}

function EmptyVaultState() {
  const [isBusy, setIsBusy] = createSignal(false);
  const status = () =>
    vaultState.configuredVaultStatus ?? {
      kind: "none" as const,
      path: null,
      message: null,
    };
  const title = () => {
    switch (status().kind) {
      case "missing":
        return t("vault.empty.title.missing");
      case "unavailable":
        return t("vault.empty.title.unavailable");
      default:
        return t("vault.empty.title.none");
    }
  };
  const description = () => {
    switch (status().kind) {
      case "missing":
        return t("vault.empty.description.missing");
      case "unavailable":
        return t("vault.empty.description.unavailable");
      default:
        return t("vault.empty.description.none");
    }
  };

  const handleSelectVault = async () => {
    if (isBusy()) return;

    setIsBusy(true);
    try {
      await selectVault();
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error("[VaultBrowser] Failed to select vault", error);
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <div class="flex min-h-0 flex-1 items-center justify-center px-4 py-6">
      <div class="flex w-full max-w-62 flex-col gap-3 rounded-xs border border-border bg-bg-primary p-4 text-center">
        <div class="space-y-1">
          <p class="text-sm font-medium text-text-primary">{title()}</p>
          <p class="text-xs/5 text-text-secondary">{description()}</p>
        </div>

        <Show when={status().path}>
          {(path) => (
            <div class="rounded-xs border border-border bg-bg-secondary px-2.5 py-2 text-left font-mono text-[0.6875rem]/4 break-all text-text-muted">
              {path()}
            </div>
          )}
        </Show>

        <Show when={status().kind === "unavailable" && status().message}>
          {(message) => <p class="text-[0.6875rem]/4 text-text-muted">{message()}</p>}
        </Show>

        <button
          type="button"
          class="rounded-xs border border-border px-3 py-2 text-sm text-text-secondary transition-colors hover:bg-ghost-hover hover:text-text-primary"
          disabled={isBusy()}
          onClick={() => void handleSelectVault()}
        >
          {isBusy() ? t("vault.empty.action.working") : t("vault.empty.action.select_vault")}
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
  let treeRootRef: HTMLDivElement | undefined;
  let pendingDragStart: {
    payload: VaultEntryDragPayload;
    startX: number;
    startY: number;
  } | null = null;
  let suppressClicksUntil = 0;
  const isAiResponding = () => getContextKey("aiResponding") === true;
  const [draggingPath, setDraggingPath] = createSignal<string | null>(null);
  const [dropIndicatorPath, setDropIndicatorPath] = createSignal<string | null>(null);
  const [isSelectingVault, setIsSelectingVault] = createSignal(false);
  const [isCreatingDemo, setIsCreatingDemo] = createSignal(false);
  const footerActionIds = () =>
    getVaultSidebarFooterActionIds({ hasOpenVault: vaultState.rootPath != null });
  const footerVaultLabel = () => getVaultSidebarFooterVaultLabel({ rootName: vaultState.rootName });
  const showRootEditInput = () =>
    vaultState.editState?.kind === "create" && vaultState.editState.parentPath === ""
      ? vaultState.editState
      : null;
  const isRootDropActive = () => dropIndicatorPath() === ROOT_DROP_TARGET;

  const resolveDestinationFolder = (entry: FileEntry): string =>
    entry.is_directory ? entry.path : getParentPath(entry.path);

  const shouldSuppressClick = () => Date.now() < suppressClicksUntil;
  const suppressClicksBriefly = () => {
    suppressClicksUntil = Date.now() + 250;
  };

  const clearDragState = () => {
    pendingDragStart = null;
    // Fold the three reactive writes + global drag-store clear into a single
    // reactive pass. Without batching, the vault tree re-evaluates drag
    // highlights three times on every drag end (mouseup/blur) — visible as
    // a flicker on WebKit with large trees.
    batch(() => {
      setDraggingPath(null);
      setDropIndicatorPath(null);
      setVaultDragChatDropActive(false);
      clearVaultDrag();
    });
  };

  const getVaultDropIndicatorAtPoint = (
    payload: VaultEntryDragPayload,
    clientX: number,
    clientY: number,
  ): string | null => {
    const root = treeRootRef;
    if (!root) {
      return null;
    }

    const hovered = document.elementFromPoint(clientX, clientY);
    if (!(hovered instanceof Element) || !root.contains(hovered)) {
      return null;
    }

    const row = hovered.closest<HTMLElement>("[data-vault-drop-path]");
    if (!row || !root.contains(row)) {
      return canMoveEntryToFolder(payload.path, "") ? ROOT_DROP_TARGET : null;
    }

    const targetPath = row.dataset.vaultDropPath ?? "";
    const targetKind = row.dataset.vaultDropKind ?? "file";
    const destinationFolderPath =
      targetKind === "directory" ? targetPath : getParentPath(targetPath);

    if (!canMoveEntryToFolder(payload.path, destinationFolderPath)) {
      return null;
    }

    return targetPath;
  };

  const resolveActiveDropTarget = (
    payload: VaultEntryDragPayload,
    clientX: number,
    clientY: number,
  ) => {
    updateVaultDragPointer(clientX, clientY);

    const hovered = document.elementFromPoint(clientX, clientY);
    const isChatDropTarget =
      !payload.isDirectory &&
      hovered instanceof Element &&
      hovered.closest("[data-ai-chat-dropzone='true']") != null;

    setVaultDragChatDropActive(isChatDropTarget);
    const indicator = isChatDropTarget
      ? null
      : getVaultDropIndicatorAtPoint(payload, clientX, clientY);
    setDropIndicatorPath(indicator);

    return {
      indicator,
      isChatDropTarget,
    };
  };

  const handleEntryMouseDown = (entry: FileEntry, event: MouseEvent) => {
    if (event.button !== 0) return;
    if (vaultState.editState) return;
    // Selection is committed on click (via `handleClick`) alongside the other
    // store writes in one batched reactive pass. Firing an extra
    // `setSelectedPath` here would add a second cascade that re-evaluates
    // every vault row's `isSelected`, which is noticeable on WebKit with
    // large trees.
    pendingDragStart = {
      payload: createVaultEntryDragPayload(entry),
      startX: event.clientX,
      startY: event.clientY,
    };
  };

  const handleDocumentMouseMove = (event: MouseEvent) => {
    if (!pendingDragStart && !vaultDragState.isDragging) return;

    if (!vaultDragState.isDragging) {
      if (!pendingDragStart) return;
      const deltaX = event.clientX - pendingDragStart.startX;
      const deltaY = event.clientY - pendingDragStart.startY;
      if (Math.hypot(deltaX, deltaY) < DRAG_THRESHOLD_PX) {
        return;
      }

      startVaultDrag(pendingDragStart.payload, event.clientX, event.clientY);
      setDraggingPath(pendingDragStart.payload.path);
      suppressClicksBriefly();
      pendingDragStart = null;
    }

    const payload = vaultDragState.payload;
    if (!payload) return;
    resolveActiveDropTarget(payload, event.clientX, event.clientY);
    event.preventDefault();
  };

  const handleDocumentMouseUp = (event: MouseEvent) => {
    const payload = vaultDragState.payload;
    if (!payload) {
      pendingDragStart = null;
      return;
    }

    const { indicator, isChatDropTarget } = resolveActiveDropTarget(
      payload,
      event.clientX,
      event.clientY,
    );

    clearDragState();
    suppressClicksBriefly();
    event.preventDefault();

    if (isChatDropTarget && !payload.isDirectory) {
      void addFileAttachment({
        path: payload.path,
        name: payload.name,
        folder: getParentPath(payload.path),
      });
      return;
    }

    if (!indicator) return;
    if (indicator === ROOT_DROP_TARGET) {
      void moveEntryToFolder(payload.path, "");
      return;
    }

    const targetEntry = findInTree(vaultState.files, indicator);
    if (!targetEntry) return;
    void moveEntryToFolder(payload.path, resolveDestinationFolder(targetEntry));
  };

  const handleWindowBlur = () => {
    clearDragState();
  };

  const handleSelectVault = async () => {
    if (isSelectingVault()) return;

    setIsSelectingVault(true);
    try {
      await selectVault();
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error("[VaultBrowser] Failed to select vault", error);
    } finally {
      setIsSelectingVault(false);
    }
  };

  const handleCreateDemoVaultSamples = async () => {
    if (isCreatingDemo()) return;

    setIsCreatingDemo(true);
    try {
      await createDemoVaultSamples();
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error("[VaultBrowser] Failed to create demo vault samples", error);
    } finally {
      setIsCreatingDemo(false);
    }
  };

  onMount(() => {
    window.addEventListener("mousemove", handleDocumentMouseMove, true);
    window.addEventListener("mouseup", handleDocumentMouseUp, true);
    window.addEventListener("blur", handleWindowBlur);
  });

  onCleanup(() => {
    window.removeEventListener("mousemove", handleDocumentMouseMove, true);
    window.removeEventListener("mouseup", handleDocumentMouseUp, true);
    window.removeEventListener("blur", handleWindowBlur);
    clearDragState();
  });

  return (
    <div class="flex h-full min-h-0 flex-col overflow-hidden">
      <div class="flex items-center justify-between px-3 py-2">
        <Show
          when={vaultState.rootPath}
          fallback={
            <span class="text-xs font-semibold tracking-[0.16em] text-text-muted uppercase">
              {t("vault.explorer")}
            </span>
          }
        >
          <KukuLogoSmall size={64} class="shrink-0" isAiResponding={isAiResponding()} />
          <div class="flex items-center gap-2">
            <button
              type="button"
              class="rounded-xs p-1 text-text-muted transition-colors hover:bg-accent-dim hover:text-text-secondary"
              title={t("vault.action.quick_search")}
              onClick={() => openSearchOmnibar()}
            >
              <SearchIcon size={16} />
            </button>
            <button
              type="button"
              class="rounded-xs p-1 text-text-muted transition-colors hover:bg-accent-dim hover:text-text-secondary"
              title={t("vault.action.new_folder")}
              onClick={startCreateFolder}
            >
              <FolderPlusIcon size={16} />
            </button>
            <button
              type="button"
              class="rounded-xs p-1 text-text-muted transition-colors hover:bg-accent-dim hover:text-text-secondary"
              title={t("vault.action.new_file")}
              onClick={startCreateFile}
            >
              <PlusIcon size={16} />
            </button>
          </div>
        </Show>
      </div>

      <Show when={vaultState.rootPath} fallback={<EmptyVaultState />}>
        <ScrollArea class="flex-1 px-1 pb-2" axis="y">
          <div
            ref={treeRootRef}
            class="min-h-full rounded-xs"
            classList={{
              "bg-accent-dim/35 ring-1 ring-accent/60": isRootDropActive(),
            }}
            onClick={(event) => {
              if (shouldSuppressClick()) return;
              handleEmptySpaceClick(event);
            }}
          >
            <Show
              when={showRootEditInput() || vaultState.files.length > 0}
              fallback={
                <div class="flex min-h-40 flex-col items-center justify-center gap-3 px-4 py-8 text-center">
                  <p class="text-xs text-text-muted">{t("vault.empty.tree")}</p>
                  <button
                    type="button"
                    class="rounded-xs border border-border px-3 py-1.5 text-xs text-text-secondary transition-colors hover:bg-ghost-hover hover:text-text-primary disabled:cursor-default disabled:opacity-50"
                    disabled={isCreatingDemo()}
                    onClick={() => void handleCreateDemoVaultSamples()}
                  >
                    {isCreatingDemo()
                      ? t("vault.empty.action.creating_demo")
                      : t("vault.empty.action.create_demo")}
                  </button>
                </div>
              }
            >
              <Show when={showRootEditInput()}>
                {(editState) => (
                  <InlineNameInput
                    editState={editState()}
                    depth={0}
                    guides={[]}
                    isLast={vaultState.files.length === 0}
                  />
                )}
              </Show>
              <For each={vaultState.files}>
                {(entry, index) => (
                  <FileTreeNode
                    entry={entry}
                    depth={0}
                    isLast={index() === vaultState.files.length - 1}
                    guides={[]}
                    draggingPath={draggingPath}
                    dropIndicatorPath={dropIndicatorPath}
                    onEntryMouseDown={handleEntryMouseDown}
                    shouldSuppressClick={shouldSuppressClick}
                  />
                )}
              </For>
            </Show>
          </div>
        </ScrollArea>
      </Show>

      <TypingIndicator />

      <Show when={footerActionIds().length > 0}>
        <div class="flex shrink-0 items-center px-2 pt-1.5 pb-2">
          <Show when={footerActionIds().includes("switch-vault")}>
            <button
              type="button"
              class="flex h-8 min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-xs border-none bg-transparent px-1.5 text-icon-muted transition-colors hover:bg-ghost-hover hover:text-icon disabled:cursor-default disabled:opacity-50"
              title={vaultState.rootPath ?? footerVaultLabel() ?? t("vault.action.switch_vault")}
              disabled={isSelectingVault()}
              onClick={() => void handleSelectVault()}
            >
              <FolderIcon size={15} class="shrink-0" />
              <Show when={footerVaultLabel()}>
                {(label) => (
                  <span class="min-w-0 truncate text-[0.75rem] text-text-muted">{label()}</span>
                )}
              </Show>
            </button>
          </Show>

          <Show when={footerActionIds().includes("settings")}>
            <button
              type="button"
              class="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-xs border-none bg-transparent text-icon-muted transition-colors hover:bg-ghost-hover hover:text-icon"
              title={t("vault.action.settings")}
              onClick={() => openSettings()}
            >
              <SettingsIcon size={15} />
            </button>
          </Show>
        </div>
      </Show>

      <DragPreview />
    </div>
  );
}
