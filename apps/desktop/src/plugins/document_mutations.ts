import { TextSelection, type EditorState, type Transaction } from "prosekit/pm/state";
import type { Node as ProseMirrorNode } from "prosekit/pm/model";

import { extractTasks, parseTaskMetadata, type PlannerTask } from "~/lib/planner_tasks";
import { pathEqualsIgnoreCase } from "~/lib/vault_path";
import { readFileWithChecksum, readVaultFile, writeFileWithChecksum } from "~/lib/vault_fs";
import {
  filesState,
  getCachedChecksum,
  getCachedContent,
  markTabDirty,
  openTab,
  saveCachedChecksum,
  saveCachedContent,
} from "~/stores/files";
import {
  getEditorDocumentSession,
  onEditorDocumentReady,
  type EditorSaveResult,
} from "~/stores/editor";
import { vaultState } from "~/stores/vault";

import { getRetainedDocument } from "./document_sessions";
import { markAutomaticDocumentChange } from "./editor_change_origin";
import { getMarkdownService } from "./markdown_service";
import { notifyDocumentSaved } from "./document_events";
import { emitEvent, onEvent } from "./events";

const mutations = new Map<string, Promise<void>>();
let cancelPendingTaskFocus: (() => void) | null = null;

function markdownService() {
  const service = getMarkdownService();
  if (!service) throw new Error("The editor is not ready");
  return service;
}

function documentTab(path: string) {
  return filesState.tabs.find(
    (tab) => tab.type === "editor" && tab.filePath && pathEqualsIgnoreCase(tab.filePath, path),
  );
}

function currentDocument(path: string) {
  const tab = documentTab(path);
  const retained = tab ? getRetainedDocument(tab.id) : undefined;
  if (retained && retained.vaultRoot === vaultState.rootPath)
    return {
      state: retained.getState(),
      dispatch: (tr: Transaction) => retained.dispatch(tr),
      save: () => retained.save(),
    };
  const session = getEditorDocumentSession(path);
  const host = session?.getHost?.();
  if (session && host && !host.isDisposed() && host.vaultRoot === vaultState.rootPath) {
    return {
      state: host.getState(),
      dispatch: (tr: Transaction) => host.dispatch(tr),
      save: () => session.save(),
    };
  }
  return null;
}

/** Read what the user sees, including unsaved work in a detached editor tab. */
export async function readCurrentDocument(path: string): Promise<string> {
  const current = currentDocument(path);
  if (current) return markdownService().stringify(current.state.doc.toJSON());
  const tab = documentTab(path);
  if (tab?.isDirty) {
    const cached = getCachedContent(tab.id);
    if (!cached) throw new Error("The note has unsaved edits that are not ready");
    return markdownService().stringify(cached);
  }
  // Bulk reads must not use the editor bootstrap path: it starts an index
  // reconciliation (and opens a DB connection) for every loaded document.
  // Actual mutations still read a checksum immediately before writing.
  return readVaultFile(path);
}

/** Keep unchanged document content and plugin positions outside the edit intact. */
export function documentChangeTransaction(
  state: EditorState,
  nextMarkdown: string,
): Transaction | null {
  const parsed = state.schema.nodeFromJSON(markdownService().parse(nextMarkdown));
  const attributes: { position: number; node: ProseMirrorNode }[] = [];
  function collectAttributes(
    previous: ProseMirrorNode,
    next: ProseMirrorNode,
    position: number,
  ): boolean {
    if (previous.type !== next.type || previous.childCount !== next.childCount) return false;
    if (previous.isText) return previous.eq(next);
    if (!previous.sameMarkup(next)) {
      if (position < 0) return false;
      attributes.push({ position, node: next });
    }
    let childPosition = position + 1;
    for (let index = 0; index < previous.childCount; index++) {
      if (!collectAttributes(previous.child(index), next.child(index), childPosition)) return false;
      childPosition += previous.child(index).nodeSize;
    }
    return true;
  }
  // Checkboxes and task scheduling change node attributes only. Keep text,
  // selection, history and retained transcript ranges inside the node intact.
  if (collectAttributes(state.doc, parsed, -1)) {
    if (attributes.length === 0) return null;
    const transaction = state.tr;
    for (const { position, node } of attributes)
      transaction.setNodeMarkup(position, undefined, node.attrs, node.marks);
    return markAutomaticDocumentChange(transaction);
  }
  const start = state.doc.content.findDiffStart(parsed.content);
  if (start === null) return null;
  const end = state.doc.content.findDiffEnd(parsed.content);
  if (!end) return null;
  const overlap = start - Math.min(end.a, end.b);
  const oldEnd = overlap > 0 ? end.a + overlap : end.a;
  const newEnd = overlap > 0 ? end.b + overlap : end.b;
  return markAutomaticDocumentChange(state.tr.replace(start, oldEnd, parsed.slice(start, newEnd)));
}

function requireSaved(result: EditorSaveResult): void {
  if (result.status === "saved") return;
  if (result.status === "conflict")
    throw new Error("The note changed on disk. Resolve its save conflict first.");
  if (result.status === "error") throw new Error(result.message);
  throw new Error(
    `The note could not be saved (${result.reason}). Your edits remain in the editor.`,
  );
}

/** Serialize plugin edits and route them through the document's existing owner. */
export function mutateDocument(
  path: string,
  transform: (markdown: string) => string,
): Promise<void> {
  const root = vaultState.rootPath;
  if (!root) return Promise.reject(new Error("Open a vault first"));
  const key = `${root}\0${path.toLowerCase()}`;
  const operation = (mutations.get(key) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      if (root !== vaultState.rootPath) throw new Error("The vault changed before the edit");
      await applyMutation(path, root, transform);
    });
  mutations.set(key, operation);
  void operation
    .finally(() => {
      if (mutations.get(key) === operation) mutations.delete(key);
    })
    .catch(() => {});
  return operation;
}

async function applyMutation(
  path: string,
  root: string,
  transform: (markdown: string) => string,
): Promise<void> {
  const service = markdownService();
  const current = currentDocument(path);
  if (current) {
    const before = service.stringify(current.state.doc.toJSON());
    const next = transform(before);
    if (next === before) return;
    const transaction = documentChangeTransaction(current.state, next);
    if (!transaction) return;
    current.dispatch(transaction);
    // Protected document ranges may reject a transaction. Do not report success.
    const applied = currentDocument(path);
    if (!applied || applied.state.doc.eq(current.state.doc)) {
      throw new Error("This part of the note is currently protected");
    }
    requireSaved(await current.save());
    return;
  }

  if (getEditorDocumentSession(path))
    throw new Error("The note is still loading. Try again when it is ready.");

  const tab = documentTab(path);
  const cached = tab?.isDirty ? getCachedContent(tab.id) : null;
  const cachedChecksum = tab?.isDirty ? getCachedChecksum(tab.id) : null;
  if (tab?.isDirty && (!cached || !cachedChecksum)) {
    throw new Error("Open the note to finish its unsaved edits first");
  }
  const disk = cached ? null : await readFileWithChecksum(path);
  if (root !== vaultState.rootPath) throw new Error("The vault changed before the edit");
  // Loading the disk may have yielded to a newly opened/edited document.
  if (currentDocument(path) || (!cached && documentTab(path)?.isDirty)) {
    return applyMutation(path, root, transform);
  }
  if (getEditorDocumentSession(path))
    throw new Error("The note is still loading. Try again when it is ready.");
  const snapshot =
    cached && cachedChecksum
      ? { content: service.stringify(cached), checksum: cachedChecksum }
      : disk;
  if (!snapshot) throw new Error("The note is not ready");
  const before = snapshot.content;
  const next = transform(before);
  if (next === before) return;
  const checksum = snapshot.checksum;
  const nextDocument = service.parse(next);
  const nextCanonical = service.stringify(nextDocument);
  // Keep a recoverable dirty copy before awaiting disk. A save failure must not
  // erase either the user's cached edits or the planner operation.
  const targetTab = documentTab(path);
  if (targetTab) {
    saveCachedContent(targetTab.id, nextDocument);
    markTabDirty(targetTab.id, true);
    emitEvent("editor:documentChanged", { filePath: path });
  }
  const result = await writeFileWithChecksum(path, next, checksum);
  if (result.status !== "Written")
    throw new Error("The note changed on disk. Resolve its save conflict first.");
  notifyDocumentSaved(path, next);
  if (root !== vaultState.rootPath) return;
  if (!targetTab || !filesState.tabs.some((entry) => entry.id === targetTab.id)) return;
  saveCachedChecksum(targetTab.id, result.checksum);
  const session = getEditorDocumentSession(path);
  const host = session?.getHost?.();
  host?.saved(result.checksum);
  const live = currentDocument(path);
  const latest = live
    ? service.stringify(live.state.doc.toJSON())
    : service.stringify(getCachedContent(targetTab.id) ?? nextDocument);
  if (latest === nextCanonical) markTabDirty(targetTab.id, false);
}

/** Reveal the source task after its editor is mounted; headings are not identities. */
export async function focusTask(task: PlannerTask): Promise<void> {
  cancelPendingTaskFocus?.();
  const path = task.path;
  const root = vaultState.rootPath;
  if (!root) return;
  const originTabId = filesState.activeTabId;
  let targetTabId: string | null = null;
  let opening = false;
  let cancelled = false;
  let sourceOrdinal = -1;
  let resolveReady: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const disposers: (() => void)[] = [];
  const cleanup = () => {
    clearTimeout(timer);
    for (const dispose of disposers.splice(0)) dispose();
    if (cancelPendingTaskFocus === cancel) cancelPendingTaskFocus = null;
  };
  const cancel = () => {
    cancelled = true;
    resolveReady?.();
    cleanup();
  };
  cancelPendingTaskFocus = cancel;
  const stillCurrent = () =>
    !cancelled &&
    vaultState.rootPath === root &&
    filesState.activeTabId === (targetTabId ?? originTabId);
  function focus(): boolean {
    if (opening || !targetTabId) return false;
    if (!stillCurrent()) {
      cancel();
      return false;
    }
    const session = getEditorDocumentSession(path);
    const host = session?.getHost?.();
    if (!host || host.isDisposed() || host.vaultRoot !== root || session?.tabId !== targetTabId)
      return false;
    if (host.isReadyForFocus?.() === false) return false;
    const state = host.getState();
    let position: number | null = null;
    let ordinal = 0;
    state.doc.descendants((node, pos) => {
      if (node.type.name !== "list" || node.attrs.kind !== "task") return;
      if (
        parseTaskMetadata(node.attrs.taskMetadata)?.id === task.id ||
        (!task.metadata && ordinal === sourceOrdinal)
      )
        position ??= pos + 2;
      ordinal++;
    });
    const target = Math.min(position ?? 1, state.doc.content.size);
    host.dispatch(
      state.tr.setSelection(TextSelection.near(state.doc.resolve(target))).scrollIntoView(),
    );
    host.focus?.();
    return true;
  }
  disposers.push(
    onEvent("vault:opened", cancel),
    onEvent("vault:closed", cancel),
    onEvent("editor:activeChanged", ({ filePath }) => {
      if (opening) return;
      if (!stillCurrent() || (targetTabId && filePath && !pathEqualsIgnoreCase(filePath, path)))
        cancel();
    }),
    onEditorDocumentReady(() => {
      if (opening) return;
      if (!stillCurrent()) {
        cancel();
        return;
      }
      if (focus()) resolveReady?.();
    }),
  );
  try {
    const sourceTasks = extractTasks(await readCurrentDocument(path), path);
    if (!stillCurrent()) return;
    sourceOrdinal = sourceTasks.findIndex((candidate) => candidate.id === task.id);
    opening = true;
    openTab(path.split("/").at(-1) ?? path, path, "editor");
    opening = false;
    const target = documentTab(path);
    if (!target || filesState.activeTabId !== target.id || vaultState.rootPath !== root) return;
    targetTabId = target.id;
    if (focus()) return;
    await new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      if (cancelled) {
        resolve();
        return;
      }
      timer = setTimeout(() => reject(new Error("The note editor did not become ready")), 8000);
    });
  } catch (error) {
    if (!cancelled) throw error;
  } finally {
    cleanup();
  }
}
