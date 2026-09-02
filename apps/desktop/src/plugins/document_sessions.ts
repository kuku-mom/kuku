import { EditorState, type Plugin, type Transaction } from "prosekit/pm/state";
import type { EditorSaveResult } from "~/stores/editor";
import { filesState, markTabDirty, saveCachedChecksum, saveCachedContent } from "~/stores/files";
import { vaultState, writeFileWithChecksum } from "~/stores/vault";
import { getMarkdownService } from "~/plugins/markdown_service";

/** A mounted editor can be detached without losing a plugin-owned document. */
export interface DocumentHost {
  tabId: string;
  filePath: string;
  vaultRoot: string;
  getState(): EditorState;
  dispatch(transaction: Transaction): void;
  restore(state: EditorState, checksum: string): void;
  saved(checksum: string): void;
  isDisposed(): boolean;
}

export interface DocumentSnapshot {
  state: EditorState;
  content: string;
  checksum: string;
}

const documents = new Map<string, RetainedDocument>();

export class RetainedDocument {
  readonly tabId: string;
  readonly filePath: string;
  readonly vaultRoot: string;
  private host: DocumentHost | null;
  private state: EditorState;
  private checksum: string;
  private queue: Promise<unknown> = Promise.resolve();
  private released = false;
  beforeSave?: (snapshot: DocumentSnapshot) => Promise<void>;

  constructor(host: DocumentHost, checksum: string) {
    this.host = host;
    this.state = host.getState();
    this.checksum = checksum;
    this.tabId = host.tabId;
    this.filePath = host.filePath;
    this.vaultRoot = host.vaultRoot;
  }

  getState(): EditorState {
    return this.host?.getState() ?? this.state;
  }
  getChecksum(): string {
    return this.checksum;
  }

  dispatch(transaction: Transaction): void {
    if (this.released) throw new Error("Document session was released");
    if (this.host) this.host.dispatch(transaction);
    else this.state = this.state.applyTransaction(transaction).state;
    this.cache();
    if (transaction.docChanged) markTabDirty(this.tabId, true);
  }

  private cache(): void {
    if (!filesState.tabs.some((tab) => tab.id === this.tabId)) return;
    saveCachedContent(this.tabId, this.getState().doc.toJSON());
    saveCachedChecksum(this.tabId, this.checksum);
  }

  detach(): void {
    this.state = this.getState();
    this.host = null;
    this.cache();
  }

  attach(host: DocumentHost): void {
    // Rendering must not wait for a slow disk or for a live transcript's save
    // loop to catch up. Writes still share this document's queue and checksum;
    // their completion notifies whichever host is attached at that time.
    if (this.released || host.isDisposed()) return;
    // Rebind view plugins and schema to the new editor. Reusing the previous
    // view's plugins would retain callbacks into an already disposed component.
    this.state = restoreDocumentState(this.getState(), host.getState());
    this.host = host;
    try {
      host.restore(this.state, this.checksum);
    } catch (error) {
      this.host = null;
      throw error;
    }
  }

  save(): Promise<EditorSaveResult> {
    const operation = this.queue.then(async (): Promise<EditorSaveResult> => {
      if (this.released) return { status: "skipped", reason: "disposed" };
      if (vaultState.rootPath !== this.vaultRoot)
        return { status: "error", message: "The document belongs to a different vault" };
      const markdown = getMarkdownService();
      if (!markdown) return { status: "skipped", reason: "not-ready" };
      try {
        for (;;) {
          const state = this.getState();
          const content = markdown.stringify(state.doc.toJSON());
          await this.beforeSave?.({ state, content, checksum: this.checksum });
          const result = await writeFileWithChecksum(this.filePath, content, this.checksum);
          if (result.status !== "Written")
            return { status: "conflict", expected: result.expected, actual: result.actual };
          this.checksum = result.checksum;
          this.host?.saved(this.checksum);
          this.cache();
          if (this.getState().doc !== state.doc) continue;
          markTabDirty(this.tabId, false);
          return { status: "saved", checksum: result.checksum, content };
        }
      } catch (error) {
        return { status: "error", message: error instanceof Error ? error.message : String(error) };
      }
    });
    this.queue = operation;
    return operation;
  }

  checkpoint(): Promise<void> {
    const operation = this.queue.then(async () => {
      if (this.released || !this.beforeSave) return;
      const markdown = getMarkdownService();
      if (!markdown) return;
      const state = this.getState();
      await this.beforeSave({
        state,
        content: markdown.stringify(state.doc.toJSON()),
        checksum: this.checksum,
      });
    });
    // A failed journal write must be reported, but must not poison future retries.
    this.queue = operation.catch(() => {});
    return operation;
  }

  async release(): Promise<void> {
    await this.queue;
    this.cache();
    this.released = true;
    this.host = null;
    documents.delete(this.tabId);
  }
}

export function restoreDocumentState(previous: EditorState, next: EditorState): EditorState {
  const fields: Record<string, Plugin> = {};
  const nextFields: Record<string, Plugin> = {};
  for (let index = 0; index < previous.plugins.length; index++) {
    const plugin = previous.plugins[index];
    if (!plugin.spec.key || !plugin.spec.state?.toJSON || !plugin.spec.state.fromJSON) continue;
    const replacement = next.plugins.find((candidate) => candidate.spec.key === plugin.spec.key);
    if (!replacement) continue;
    fields[`retained${index}`] = plugin;
    nextFields[`retained${index}`] = replacement;
  }
  return EditorState.fromJSON(
    { schema: next.schema, plugins: next.plugins },
    previous.toJSON(fields),
    nextFields,
  );
}

export function retainDocument(host: DocumentHost, checksum: string): RetainedDocument {
  if (documents.has(host.tabId)) throw new Error("Document is already retained");
  const document = new RetainedDocument(host, checksum);
  documents.set(host.tabId, document);
  return document;
}

export function getRetainedDocument(tabId: string): RetainedDocument | undefined {
  return documents.get(tabId);
}

export function detachRetainedDocument(tabId: string): void {
  documents.get(tabId)?.detach();
}
