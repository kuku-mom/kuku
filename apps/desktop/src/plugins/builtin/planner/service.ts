import { createSignal } from "solid-js";
import { createStore, reconcile, unwrap } from "solid-js/store";

import {
  extractTasks,
  updateTaskMarkdown,
  deleteTaskMarkdown,
  taskMetadataComment,
  type PlannerTask,
  type TaskMetadata,
  type TaskPatch,
} from "~/lib/planner_tasks";
import { mkdir } from "~/lib/vault_fs";
import { mutateDocument, readCurrentDocument } from "~/plugins/document_mutations";
import { loadPluginSettings, savePluginSettings } from "~/plugins/settings_store";
import type { PluginContext } from "~/plugins/types";

import { addDays, calendarDays, dateFromKey, localDate, weekDays } from "./dates";
import { linkNote, readNoteLinks } from "./links";
import { providers } from "./providers";
import { BINDINGS_PATH, readTimeBlockLinks, sameInstant, validEventRef } from "./bindings";
import { PlannerWriteController } from "./write_controller";
import { PlannerUndoController } from "./undo";
import {
  DEFAULT_PREFERENCES,
  PROVIDERS,
  externalKey,
  calendarKey,
  sameEventRef,
  type CalendarChoice,
  type ExternalCalendar,
  type ExternalItem,
  type ItemDraft,
  type ItemPatch,
  type PendingOperation,
  type PlannerPreferences,
  type Provider,
  type SourceState,
  type TaskRef,
  type TimeBlockLink,
} from "./types";

function emptySource(provider: Provider): SourceState {
  return {
    status: { provider, connected: false, configured: true },
    calendars: [],
    items: [],
    loading: false,
  };
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function validDate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(`${value}T00:00:00Z`)) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
  );
}
function validItem(value: unknown, provider: Provider, selected: string[]): value is ExternalItem {
  if (
    !isRecord(value) ||
    value.provider !== provider ||
    typeof value.id !== "string" ||
    typeof value.calendarId !== "string" ||
    !selected.includes(value.calendarId) ||
    typeof value.title !== "string" ||
    typeof value.allDay !== "boolean"
  )
    return false;
  if (value.kind !== "event" && value.kind !== "reminder") return false;
  for (const field of ["start", "end", "dueDate"] as const) {
    const date = value[field];
    if (
      date !== undefined &&
      !(
        validDate(date) ||
        (typeof date === "string" &&
          /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(date) &&
          Number.isFinite(Date.parse(date)))
      )
    )
      return false;
  }
  if (value.kind === "event" && (typeof value.start !== "string" || typeof value.end !== "string"))
    return false;
  if (value.completed !== undefined && typeof value.completed !== "boolean") return false;
  if (
    value.writeRef !== undefined &&
    (!validEventRef(value.writeRef) ||
      value.writeRef.provider !== provider ||
      value.writeRef.calendarId !== value.calendarId)
  )
    return false;
  if (value.writable !== undefined && typeof value.writable !== "boolean") return false;
  return ["timeZone", "url", "externalId", "occurrence"].every(
    (field) => value[field] === undefined || typeof value[field] === "string",
  );
}
function normalizePreferences(raw: Record<string, unknown>): PlannerPreferences {
  const enabled = isRecord(raw.enabledSources) ? raw.enabledSources : {};
  const selected = isRecord(raw.selectedCalendars) ? raw.selectedCalendars : {};
  return {
    defaultCalendar:
      isRecord(raw.defaultCalendar) &&
      (raw.defaultCalendar.provider === "google" ||
        raw.defaultCalendar.provider === "apple-calendar") &&
      typeof raw.defaultCalendar.calendarId === "string" &&
      raw.defaultCalendar.calendarId
        ? { provider: raw.defaultCalendar.provider, calendarId: raw.defaultCalendar.calendarId }
        : null,
    calendarAliases: isRecord(raw.calendarAliases)
      ? Object.fromEntries(
          Object.entries(raw.calendarAliases).filter(
            (pair): pair is [string, string] => typeof pair[1] === "string" && !!pair[1].trim(),
          ),
        )
      : {},
    preferredConnectors: isRecord(raw.preferredConnectors)
      ? Object.fromEntries(
          Object.entries(raw.preferredConnectors).filter((pair): pair is [string, Provider] =>
            PROVIDERS.includes(pair[1] as Provider),
          ),
        )
      : {},
    excludedFolders: Array.isArray(raw.excludedFolders)
      ? raw.excludedFolders.filter(
          (path): path is string => typeof path === "string" && !!path.trim(),
        )
      : [],
    enabledSources: Object.fromEntries(
      PROVIDERS.map((provider) => [provider, enabled[provider] === true]),
    ) as PlannerPreferences["enabledSources"],
    selectedCalendars: Object.fromEntries(
      PROVIDERS.map((provider) => [
        provider,
        Array.isArray(selected[provider])
          ? [
              ...new Set(
                selected[provider].filter((id): id is string => typeof id === "string" && !!id),
              ),
            ]
          : [],
      ]),
    ) as PlannerPreferences["selectedCalendars"],
  };
}
interface PlannerState {
  tasks: PlannerTask[];
  notes: string[];
  links: Record<string, string[]>;
  loading: boolean;
  error: string | null;
  anchor: string;
  sources: Record<Provider, SourceState>;
  preferences: PlannerPreferences;
  timeBlockLinks: TimeBlockLink[];
  operations: PendingOperation[];
}
// Plugin reactivation shares these queues, so an earlier instance cannot save
// over settings/cache loaded by its replacement.
let cacheQueue: Promise<void> = Promise.resolve();
let preferenceQueue: Promise<void> = Promise.resolve();

export class PlannerService {
  private readonly ctx: PluginContext;
  private disposed = false;
  private activated = false;
  private generation = 0;
  private scanGeneration = 0;
  private refreshGenerations: Record<Provider, number> = {
    google: 0,
    "apple-calendar": 0,
    "apple-reminders": 0,
  };
  private connectionGenerations: Record<Provider, number> = {
    google: 0,
    "apple-calendar": 0,
    "apple-reminders": 0,
  };
  private connecting = new Set<Provider>();
  private sourceReady = new Set<Provider>();
  private cleanups: (() => void)[] = [];
  private scanTimer?: ReturnType<typeof setTimeout>;
  private visibleCount = 0;
  private visibleDays: 1 | 3 | 7 = 7;
  private pollTimer?: ReturnType<typeof setInterval>;
  private revisionTimer?: ReturnType<typeof setInterval>;
  private revisionPending = false;
  private appleRevision = -1;
  private writes: PlannerWriteController;
  readonly undo: PlannerUndoController;
  readonly state;
  private set;

  constructor(ctx: PluginContext) {
    this.ctx = ctx;
    const [state, set] = createStore<PlannerState>({
      tasks: [],
      notes: [],
      links: {},
      loading: false,
      error: null,
      anchor: localDate(),
      sources: {
        google: { ...emptySource("google"), loading: true },
        "apple-calendar": { ...emptySource("apple-calendar"), loading: true },
        "apple-reminders": { ...emptySource("apple-reminders"), loading: true },
      },
      preferences: structuredClone(DEFAULT_PREFERENCES),
      timeBlockLinks: [],
      operations: [],
    });
    this.state = state;
    this.set = set;
    this.writes = new PlannerWriteController({
      ctx,
      state,
      token: () => this.vaultToken(),
      assertToken: (token) => this.assertVault(token),
      updateLocal: (task, patch, expected) => this.updateTaskLocal(task, patch, expected),
      scan: () => this.scan(),
      setLinks: (links) => this.set("timeBlockLinks", links),
      setOperations: (operations) => this.set("operations", operations),
      acceptItem: (item) => {
        const visible =
          this.state.preferences.enabledSources[item.provider] &&
          this.state.preferences.selectedCalendars[item.provider].includes(item.calendarId) &&
          this.visibleCalendars(item.provider).some((calendar) => calendar.id === item.calendarId);
        this.set("sources", item.provider, "items", (items) => [
          ...items.filter((value) =>
            item.writeRef && value.writeRef
              ? !sameEventRef(item.writeRef, value.writeRef)
              : value.id !== item.id,
          ),
          ...(visible ? [item] : []),
        ]);
        void this.persistCache().catch((error) => this.report(error));
      },
      removeItem: (ref) => {
        this.set("sources", ref.provider, "items", (items) =>
          items.filter((item) =>
            item.writeRef ? !sameEventRef(item.writeRef, ref) : item.id !== ref.itemId,
          ),
        );
        void this.persistCache().catch((error) => this.report(error));
      },
      report: (error) => this.report(error),
    });
    this.undo = new PlannerUndoController(this);
  }
  report(error: unknown) {
    if (!this.disposed) this.set("error", errorMessage(error));
  }
  clearError() {
    if (!this.disposed) this.set("error", null);
  }

  async activate() {
    if (this.activated || this.disposed) return;
    this.activated = true;
    const changedVault = () => {
      if (this.disposed) return;
      this.generation++;
      this.scanGeneration++;
      clearTimeout(this.scanTimer);
      this.set({ tasks: [], notes: [], loading: false, error: null });
      this.set("links", reconcile({}));
      this.writes.reset();
      this.undo.clear();
      if (this.ctx.vault.rootPath) this.scheduleScan();
    };
    this.cleanups.push(
      this.ctx.events.on("vault:opened", changedVault),
      this.ctx.events.on("vault:closed", changedVault),
      this.ctx.events.on("editor:saved", () => this.scheduleScan()),
      this.ctx.events.on("editor:activeChanged", () => this.scheduleScan()),
      this.ctx.events.on("editor:documentChanged", () => this.scheduleScan()),
    );
    const unlisten = await this.ctx.vault.onFileChanged(() => this.scheduleScan());
    if (this.disposed) {
      unlisten();
      return;
    }
    this.cleanups.push(unlisten);
    const resume = () => {
      if (this.visibleCount && document.visibilityState !== "hidden") void this.refresh();
    };
    window.addEventListener("focus", resume);
    document.addEventListener("visibilitychange", resume);
    this.cleanups.push(() => {
      window.removeEventListener("focus", resume);
      document.removeEventListener("visibilitychange", resume);
    });

    await Promise.allSettled([preferenceQueue, cacheQueue]);
    if (this.disposed) return;
    const preferences = await loadPluginSettings<PlannerPreferences>({
      pluginId: "planner",
      defaults: DEFAULT_PREFERENCES,
      normalize: normalizePreferences,
    });
    if (this.disposed) return;
    this.set("preferences", reconcile(preferences));
    let cache: Record<string, unknown> = {};
    try {
      if (await this.ctx.fs.exists("external-cache.json")) {
        const value: unknown = JSON.parse(await this.ctx.fs.readFile("external-cache.json"));
        if (isRecord(value) && value.version === 1 && isRecord(value.sources))
          cache = value.sources;
      }
    } catch {
      /* A damaged cache is rebuilt from the providers. */
    }
    if (this.disposed) return;
    // Local notes do not wait for a slow or offline external calendar.
    if (this.ctx.vault.rootPath)
      await this.writes.loadJournal().catch((error) => this.report(error));
    if (this.disposed) return;
    const initialScan = this.scan();
    await Promise.all(
      PROVIDERS.map(async (provider) => {
        const sequence = this.connectionGenerations[provider];
        const current = () => !this.disposed && sequence === this.connectionGenerations[provider];
        try {
          const status = await providers.status(provider);
          if (!current()) return;
          this.set("sources", provider, "status", reconcile(status));
          if (status.error) this.set("sources", provider, "error", status.error);
          if (!status.connected || !this.state.preferences.enabledSources[provider]) return;
          const value = cache[provider];
          if (isRecord(value) && Array.isArray(value.items)) {
            this.set("sources", provider, {
              items: value.items.filter((item) =>
                validItem(item, provider, this.state.preferences.selectedCalendars[provider]),
              ),
              updatedAt:
                typeof value.updatedAt === "string" && Number.isFinite(Date.parse(value.updatedAt))
                  ? value.updatedAt
                  : undefined,
              range: validDate(value.range) ? value.range : undefined,
            });
          }
          const calendars = await providers.calendars(provider);
          if (!current()) return;
          this.set("sources", provider, "calendars", calendars);
          if (this.pruneCalendars(provider))
            await Promise.all([this.persistPreferences(), this.persistCache()]);
        } catch (error) {
          if (current()) this.set("sources", provider, "error", errorMessage(error));
        } finally {
          if (current()) {
            this.sourceReady.add(provider);
            this.set("sources", provider, "loading", false);
          }
        }
      }),
    );
    await initialScan;
    if (this.disposed) return;
    // Remove cached records whose connection was revoked before startup.
    await this.persistCache().catch((error) => this.report(error));
    if (this.visibleCount) await this.refreshExternal();
  }

  private scheduleScan() {
    if (this.disposed) return;
    clearTimeout(this.scanTimer);
    this.scanTimer = setTimeout(() => void this.scan(), 250);
  }
  async scan(options?: { sync?: boolean; throwOnError?: boolean }) {
    const root = this.ctx.vault.rootPath;
    if (!root || this.disposed) {
      if (options?.throwOnError) throw new Error("Open an active vault first.");
      return;
    }
    const generation = this.generation,
      scan = ++this.scanGeneration;
    const current = () =>
      !this.disposed &&
      generation === this.generation &&
      scan === this.scanGeneration &&
      root === this.ctx.vault.rootPath;
    const cancelled = () => {
      if (current()) return false;
      if (options?.throwOnError) throw new Error("The Planner scan was superseded. Read again.");
      return true;
    };
    this.set("loading", true);
    try {
      await this.writes.loadJournal().catch((error) => {
        if (options?.throwOnError) throw error;
        this.report(error);
      });
      if (cancelled()) return;
      const entries = await this.ctx.vault.listFiles();
      if (cancelled()) return;
      const paths: string[] = [];
      const visit = (nodes: typeof entries) => {
        for (const node of nodes) {
          if (node.is_directory) visit(node.children ?? []);
          else if (/\.md$/i.test(node.path)) paths.push(node.path);
        }
      };
      visit(entries);
      const tasks: PlannerTask[] = [],
        links: Record<string, string[]> = {};
      const failures: string[] = [];
      let timeBlockLinks: TimeBlockLink[] = [];
      for (let index = 0; index < paths.length; index += 8) {
        if (cancelled()) return;
        await Promise.all(
          paths.slice(index, index + 8).map(async (path) => {
            try {
              const markdown = await readCurrentDocument(path);
              if (!current()) return;
              if (path === BINDINGS_PATH) timeBlockLinks = readTimeBlockLinks(markdown);
              if (
                !this.state.preferences.excludedFolders.some(
                  (folder) => path === folder || path.startsWith(`${folder}/`),
                )
              )
                tasks.push(...extractTasks(markdown, path));
              for (const link of readNoteLinks(markdown)) (links[link.key] ??= []).push(path);
            } catch {
              failures.push(path);
            }
          }),
        );
      }
      if (cancelled()) return;
      if (failures.length && options?.throwOnError)
        throw new Error(`Could not read: ${failures.join(", ")}`);
      tasks.sort((a, b) => a.path.localeCompare(b.path) || a.sourceStart - b.sourceStart);
      this.set({ tasks, notes: paths });
      this.set("links", reconcile(links));
      this.set("timeBlockLinks", timeBlockLinks);
      if (failures.length) this.report(`Could not read: ${failures.join(", ")}`);
      if (options?.sync !== false && !failures.includes(BINDINGS_PATH)) this.writes.queueSync();
    } catch (error) {
      if (current()) this.report(error);
      if (options?.throwOnError) throw error;
    } finally {
      if (current()) this.set("loading", false);
    }
  }

  private vaultToken() {
    if (this.disposed || !this.ctx.vault.rootPath) throw new Error("Open a vault first.");
    return { root: this.ctx.vault.rootPath, generation: this.generation };
  }
  private assertVault(token: { root: string; generation: number }) {
    if (
      this.disposed ||
      token.root !== this.ctx.vault.rootPath ||
      token.generation !== this.generation
    )
      throw new Error("The vault changed before the edit. Try again in the current vault.");
  }
  private async updateTaskLocal(
    task: PlannerTask,
    patch: TaskPatch,
    expected?: { title: string; start?: string; end?: string },
    expectedTask?: PlannerTask,
  ): Promise<PlannerTask> {
    const token = this.vaultToken();
    if (!this.state.tasks.some((current) => current.id === task.id && current.path === task.path))
      throw new Error("This task is no longer available in the current vault.");
    const duplicates = task.metadata?.id
      ? this.state.tasks.filter((current) => current.metadata?.id === task.metadata?.id)
      : [];
    if (duplicates.length > 1)
      throw new Error(
        "Duplicate task ID. Remove the copied task metadata before editing this task.",
      );
    let changed: PlannerTask | undefined;
    await mutateDocument(task.path, (markdown) => {
      this.assertVault(token);
      const current = extractTasks(markdown, task.path).find((value) =>
        task.metadata
          ? value.metadata?.id === task.metadata.id
          : value.sourceStart === task.sourceStart,
      );
      if (
        expected &&
        (!current ||
          current.title !== expected.title ||
          !sameInstant(current.metadata?.scheduledStart, expected.start) ||
          !sameInstant(current.metadata?.scheduledEnd, expected.end))
      )
        throw new Error("CONFLICT: The task changed before the calendar edit could be applied.");
      if (expectedTask) {
        const keys = new Set([
          ...Object.keys(current?.metadata ?? {}),
          ...Object.keys(expectedTask.metadata ?? {}),
        ]);
        if (
          !current ||
          current.title !== expectedTask.title ||
          current.checked !== expectedTask.checked ||
          [...keys].some(
            (key) =>
              JSON.stringify(
                (current.metadata as unknown as Record<string, unknown> | null)?.[key],
              ) !==
              JSON.stringify(
                (expectedTask.metadata as unknown as Record<string, unknown> | null)?.[key],
              ),
          )
        )
          throw new Error("CONFLICT: The task changed before the requested edit could be applied.");
      }
      const next = updateTaskMarkdown(markdown, task, patch);
      changed = extractTasks(next, task.path).find((value) =>
        current?.metadata
          ? value.metadata?.id === current.metadata.id
          : value.sourceStart === current?.sourceStart,
      );
      return next;
    });
    this.assertVault(token);
    await this.scan();
    this.assertVault(token);
    if (!changed) throw new Error("The edited task could not be found.");
    return (
      this.state.tasks.find((value) => value.metadata?.id === changed!.metadata?.id) ?? changed
    );
  }
  async updateTask(
    task: PlannerTask,
    patch: { title?: string; checked?: boolean; metadata?: Partial<TaskMetadata> },
    expected?: PlannerTask,
    expectedDestination?: CalendarChoice | null,
  ) {
    return this.writes.run(async () => {
      this.assertScheduleDestination(task, expectedDestination);
      const updated = await this.updateTaskLocal(task, patch, undefined, expected);
      this.assertScheduleDestination(updated, expectedDestination);
      await this.writes.publishTask(
        updated,
        !!patch.metadata &&
          (Object.hasOwn(patch.metadata, "scheduledStart") ||
            Object.hasOwn(patch.metadata, "scheduledEnd")),
      );
      return (
        this.state.tasks.find((value) => value.metadata?.id === updated.metadata?.id) ?? updated
      );
    });
  }
  async addTask(
    title: string,
    options?: {
      source?: { provider: "apple-reminders"; calendarId: string };
      metadata?: Partial<TaskMetadata>;
    },
  ): Promise<TaskRef> {
    const clean = title.replace(/[\r\n]+/g, " ").trim();
    if (!clean) throw new Error("Enter a task title.");
    return this.writes.run(async () => {
      const token = this.vaultToken();
      if (options?.source) {
        await this.selectCalendar(options.source.provider, options.source.calendarId, true);
        this.assertVault(token);
        const item = await this.writes.createItem(
          options.source.provider,
          options.source.calendarId,
          { title: clean, allDay: true, dueDate: options.metadata?.dueDate, completed: false },
        );
        if (!item.writeRef) throw new Error("The saved reminder has no writable reference.");
        if (options.metadata?.scheduledStart)
          await this.writes
            .scheduleReminder(item, options.metadata)
            .catch((error) => this.report(error));
        return { kind: "reminder", eventRef: item.writeRef };
      }
      const id = crypto.randomUUID();
      this.assertVault(token);
      await mkdir("Tasks");
      this.assertVault(token);
      const path = "Tasks/Inbox.md";
      const append = (markdown: string) => {
        this.assertVault(token);
        const literal = clean.replace(/([\\`*_{}[\]<>&])/g, String.raw`\$1`);
        return `${markdown}${markdown && !markdown.endsWith("\n") ? "\n" : ""}- [ ] ${literal} ${taskMetadataComment({ ...options?.metadata, id })}\n`;
      };
      const exists = await this.ctx.vault.exists(path);
      this.assertVault(token);
      if (exists) await mutateDocument(path, append);
      else await this.ctx.vault.writeFile(path, append("# Inbox\n\n"));
      this.assertVault(token);
      await this.scan();
      this.assertVault(token);
      const task = this.state.tasks.find((value) => value.metadata?.id === id);
      if (!task) throw new Error("The new task could not be found.");
      if (options?.metadata?.scheduledStart)
        await this.writes.publishTask(task, true).catch((error) => this.report(error));
      return { kind: "note", taskId: id, path };
    });
  }
  async deleteTask(task: PlannerTask, deleteBlock: boolean, expected?: PlannerTask) {
    return this.writes.run(async () => {
      const token = this.vaultToken();
      let expectedChecksum = expected?.sourceChecksum;
      const assertExpected = (markdown: string) => {
        if (!expected) return;
        const latest = extractTasks(markdown, task.path).find((value) =>
          task.metadata?.id ? value.metadata?.id === task.metadata.id : value.id === task.id,
        );
        if (!latest || latest.sourceChecksum !== expectedChecksum)
          throw new Error("CONFLICT: The task's note changed before deletion. Read it again.");
      };
      if (
        task.metadata?.id &&
        this.state.tasks.filter((value) => value.metadata?.id === task.metadata?.id).length !== 1
      )
        throw new Error("Duplicate or missing task ID.");
      if (expected) {
        const markdown = await readCurrentDocument(task.path);
        assertExpected(markdown);
        this.assertVault(token);
        // Removing a linked block first clears exactly these metadata fields
        // through the normal document path. Permit that known change only.
        if (deleteBlock && this.timeBlockForTask(task)) {
          const afterUnassign = updateTaskMarkdown(markdown, task, {
            metadata: {
              scheduledStart: undefined,
              scheduledEnd: undefined,
              timeZone: undefined,
              timeBlockLinkId: undefined,
            },
          });
          expectedChecksum = extractTasks(afterUnassign, task.path).find(
            (value) => value.metadata?.id === task.metadata?.id,
          )?.sourceChecksum;
        }
      }
      await this.writes.beforeDeleteTask(task, deleteBlock);
      await mutateDocument(task.path, (markdown) => {
        this.assertVault(token);
        assertExpected(markdown);
        return deleteTaskMarkdown(markdown, task);
      });
      this.assertVault(token);
      await this.writes.afterDeleteTask(task);
      this.assertVault(token);
      await this.scan();
    });
  }
  createItem(provider: Provider, calendarId: string, draft: ItemDraft) {
    return this.writes.run(() => this.writes.createItem(provider, calendarId, draft));
  }
  updateItem(item: ExternalItem, patch: ItemPatch) {
    return this.writes.run(async () => {
      const result = await this.writes.updateItem(item, patch);
      this.writes.queueSync();
      return result;
    });
  }
  deleteItem(item: ExternalItem) {
    return this.writes.run(() => this.writes.deleteItem(item));
  }
  scheduleReminder(
    item: ExternalItem,
    metadata: Partial<TaskMetadata>,
    expectedDestination?: CalendarChoice | null,
  ) {
    return this.writes.run(() => {
      this.assertScheduleDestination(item, expectedDestination);
      return this.writes.scheduleReminder(item, metadata);
    });
  }
  private assertScheduleDestination(
    item: PlannerTask | ExternalItem,
    expected?: CalendarChoice | null,
  ) {
    if (expected === undefined) return;
    const link = this.timeBlockForTask(item);
    const actual = link?.eventRef ?? this.state.preferences.defaultCalendar ?? null;
    if (
      (actual?.provider ?? null) !== (expected?.provider ?? null) ||
      (actual?.calendarId ?? null) !== (expected?.calendarId ?? null)
    )
      throw new Error(
        "CONFLICT: The scheduling calendar changed. Read the task before assigning time again.",
      );
  }
  removeReminderBlock(item: ExternalItem) {
    return this.scheduleReminder(item, { scheduledStart: undefined, scheduledEnd: undefined });
  }
  timeBlockForTask(task: PlannerTask | ExternalItem) {
    return this.writes.timeBlockForTask(task);
  }
  linkedTask(item: ExternalItem) {
    return this.writes.linkedTask(item);
  }
  retryOperation(id: string, reviewedVersion?: string) {
    return this.writes.run(async () => {
      const result = await this.writes.retryOperation(id, reviewedVersion);
      this.writes.queueSync();
      return result;
    });
  }
  dismissOperation(id: string) {
    return this.writes.run(() => this.writes.dismissOperation(id));
  }
  resolveLink(
    id: string,
    choice: "task" | "event",
    reviewedVersion?: string,
    reviewedTask?: { title: string; start?: string; end?: string },
  ) {
    return this.writes.run(() =>
      this.writes.resolveLink(id, choice, reviewedVersion, reviewedTask),
    );
  }
  async attachNote(item: ExternalItem, path: string) {
    const token = this.vaultToken();
    if (!this.state.notes.includes(path)) throw new Error("Choose an existing note in this vault.");
    await mutateDocument(path, (markdown) => {
      this.assertVault(token);
      return linkNote(markdown, item);
    });
    this.assertVault(token);
    await this.scan();
  }
  async createNote(item: ExternalItem): Promise<string> {
    const token = this.vaultToken();
    await mkdir("Calendar");
    this.assertVault(token);
    const date = item.allDay
      ? item.start?.slice(0, 10)
      : item.start
        ? localDate(new Date(item.start))
        : item.dueDate?.slice(0, 10);
    const title =
      item.title
        .replace(/[\\/:*?"<>|\r\n]/g, " ")
        .trim()
        .slice(0, 90) || "Note";
    const path = `Calendar/${date ?? localDate()} ${title} ${crypto.randomUUID().slice(0, 8)}.md`;
    await this.ctx.vault.writeFile(
      path,
      linkNote(`# ${item.title.replace(/[\r\n]/g, " ")}\n\n`, item),
    );
    this.assertVault(token);
    await this.scan();
    return path;
  }
  linkedNotes(item: ExternalItem) {
    return this.state.links[externalKey(item)] ?? [];
  }
  setAnchor(anchor: string, visibleDays: 1 | 3 | 7 = 7) {
    if (this.disposed || !validDate(anchor)) return;
    this.visibleDays = visibleDays;
    this.set("anchor", anchor);
    for (const provider of PROVIDERS) this.refreshGenerations[provider]++;
    if (this.visibleCount) void this.refreshExternal();
  }
  async setExcludedFolders(folders: string[]) {
    if (this.disposed) return;
    this.set("preferences", "excludedFolders", [
      ...new Set(folders.map((path) => path.trim().replace(/^\/+|\/+$/g, "")).filter(Boolean)),
    ]);
    await this.persistPreferences();
    await this.scan();
  }
  calendarLabel(calendar: ExternalCalendar): string {
    return (
      this.state.preferences.calendarAliases?.[calendarKey(calendar.provider, calendar.id)] ??
      calendar.title
    );
  }
  visibleCalendars(provider: Provider): ExternalCalendar[] {
    return this.state.sources[provider].calendars.filter((calendar) => {
      const alias = this.state.preferences.calendarAliases?.[calendarKey(provider, calendar.id)];
      const preferred = alias && this.state.preferences.preferredConnectors?.[alias];
      return !preferred || preferred === provider;
    });
  }
  async setDefaultCalendar(choice: CalendarChoice | null) {
    if (this.disposed) return;
    if (choice) {
      const source = this.state.sources[choice.provider];
      if (
        !source.status.connected ||
        source.status.writable !== true ||
        !this.state.preferences.enabledSources[choice.provider] ||
        !this.visibleCalendars(choice.provider).some(
          (calendar) => calendar.id === choice.calendarId && calendar.writable === true,
        )
      )
        throw new Error("Select a connected, writable calendar.");
      this.set("preferences", "selectedCalendars", choice.provider, (ids) => [
        ...new Set([...ids, choice.calendarId]),
      ]);
    }
    this.set("preferences", "defaultCalendar", choice);
    await this.persistPreferences();
  }
  async setCalendarAlias(provider: Provider, calendarId: string, alias: string) {
    if (this.disposed) return;
    if (!this.state.sources[provider].calendars.some((calendar) => calendar.id === calendarId))
      throw new Error("This calendar is unavailable.");
    const aliases = { ...this.state.preferences.calendarAliases };
    const key = calendarKey(provider, calendarId),
      clean = alias.trim();
    if (clean) aliases[key] = clean;
    else delete aliases[key];
    this.set("preferences", "calendarAliases", reconcile(aliases));
    await this.persistPreferences();
  }
  async setPreferredConnector(alias: string, provider: Provider | null) {
    if (this.disposed) return;
    if (
      provider &&
      !this.state.sources[provider].calendars.some(
        (calendar) =>
          this.state.preferences.calendarAliases?.[calendarKey(provider, calendar.id)] === alias,
      )
    )
      throw new Error("Choose a connector with this explicit calendar alias.");
    const preferred = { ...this.state.preferences.preferredConnectors };
    if (provider) preferred[alias] = provider;
    else delete preferred[alias];
    this.set("preferences", "preferredConnectors", reconcile(preferred));
    const choice = this.state.preferences.defaultCalendar;
    if (
      choice &&
      !this.visibleCalendars(choice.provider).some((calendar) => calendar.id === choice.calendarId)
    )
      this.set("preferences", "defaultCalendar", null);
    for (const source of PROVIDERS) {
      const visible = new Set(this.visibleCalendars(source).map((calendar) => calendar.id));
      this.set("sources", source, "items", (items) =>
        items.filter((item) => visible.has(item.calendarId)),
      );
    }
    await Promise.all([this.persistPreferences(), this.persistCache()]);
    await this.refreshExternal();
  }
  private persistPreferences() {
    const snapshot = structuredClone(unwrap(this.state.preferences));
    preferenceQueue = preferenceQueue
      .catch(() => {})
      .then(() => savePluginSettings("planner", snapshot));
    return preferenceQueue;
  }

  async connect(provider: Provider) {
    if (this.disposed || !this.sourceReady.has(provider) || this.connecting.has(provider)) return;
    const sequence = ++this.connectionGenerations[provider];
    this.writes.disconnect(provider);
    this.undo.clear();
    this.refreshGenerations[provider]++;
    const current = () => !this.disposed && sequence === this.connectionGenerations[provider];
    this.connecting.add(provider);
    this.set("sources", provider, { loading: true, error: undefined });
    try {
      const status = await providers.connect(provider);
      if (!current()) return;
      this.set("sources", provider, "status", reconcile(status));
      if (!status.connected) throw new Error(status.error ?? "Connection was not granted.");
      // A fresh consent flow may select a different Google account. Require
      // explicit calendar selection so previous-account cache never carries over.
      this.set("preferences", "selectedCalendars", provider, []);
      if (this.state.preferences.defaultCalendar?.provider === provider)
        this.set("preferences", "defaultCalendar", null);
      this.set("preferences", "enabledSources", provider, true);
      this.set("sources", provider, {
        calendars: [],
        items: [],
        updatedAt: undefined,
        range: undefined,
      });
      await Promise.all([this.persistPreferences(), this.persistCache()]);
      if (!current()) return;
      const calendars = await providers.calendars(provider);
      if (current()) this.set("sources", provider, "calendars", calendars);
    } catch (error) {
      if (current()) this.set("sources", provider, "error", errorMessage(error));
    } finally {
      if (sequence === this.connectionGenerations[provider]) this.connecting.delete(provider);
      if (current()) this.set("sources", provider, "loading", false);
    }
  }
  async disconnect(provider: Provider) {
    if (this.disposed) return;
    const sequence = ++this.connectionGenerations[provider];
    this.writes.disconnect(provider);
    this.undo.clear();
    this.refreshGenerations[provider]++;
    this.connecting.delete(provider);
    this.set("preferences", "enabledSources", provider, false);
    this.set("preferences", "selectedCalendars", provider, []);
    if (this.state.preferences.defaultCalendar?.provider === provider)
      this.set("preferences", "defaultCalendar", null);
    const configured = this.state.sources[provider].status.configured;
    this.set("sources", provider, reconcile(emptySource(provider)));
    this.set("sources", provider, "status", "configured", configured);
    // Cancellation must reach the native adapter even if saving preferences or
    // deleting the cached snapshot fails.
    const results = await Promise.allSettled([
      providers.disconnect(provider),
      this.persistPreferences(),
      this.persistCache(),
    ]);
    if (this.disposed || sequence !== this.connectionGenerations[provider]) return;
    this.sourceReady.add(provider);
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") {
      this.set("sources", provider, "error", errorMessage(failure.reason));
      throw failure.reason;
    }
  }
  private pruneCalendars(provider: Provider): boolean {
    const available = new Set(
      this.state.sources[provider].calendars.map((calendar) => calendar.id),
    );
    const selected = this.state.preferences.selectedCalendars[provider];
    const next = selected.filter((id) => available.has(id));
    const choice = this.state.preferences.defaultCalendar;
    const clearDefault = choice?.provider === provider && !available.has(choice.calendarId);
    if (clearDefault) this.set("preferences", "defaultCalendar", null);
    if (next.length === selected.length) return clearDefault;
    this.set("preferences", "selectedCalendars", provider, next);
    this.set("sources", provider, "items", (items) =>
      items.filter((item) => next.includes(item.calendarId)),
    );
    return true;
  }
  async selectCalendar(provider: Provider, id: string, selected: boolean) {
    if (this.disposed || !this.state.preferences.enabledSources[provider]) return;
    if (selected && !this.state.sources[provider].calendars.some((calendar) => calendar.id === id))
      throw new Error("This calendar is no longer available.");
    this.refreshGenerations[provider]++;
    const ids = this.state.preferences.selectedCalendars[provider];
    this.set(
      "preferences",
      "selectedCalendars",
      provider,
      selected ? [...new Set([...ids, id])] : ids.filter((value) => value !== id),
    );
    this.set("sources", provider, "items", (items) =>
      items.filter((item) =>
        this.state.preferences.selectedCalendars[provider].includes(item.calendarId),
      ),
    );
    await Promise.all([this.persistPreferences(), this.persistCache()]);
    await this.refreshSource(provider);
  }
  async refresh() {
    await Promise.all([this.scan(), this.refreshExternal()]);
  }
  async refreshExternal() {
    await Promise.all(PROVIDERS.map((provider) => this.refreshSource(provider)));
    this.writes.queueSync();
  }
  private async refreshSource(provider: Provider) {
    if (
      this.disposed ||
      !this.state.preferences.enabledSources[provider] ||
      this.connecting.has(provider)
    )
      return;
    const sequence = ++this.refreshGenerations[provider];
    const current = () =>
      !this.disposed &&
      sequence === this.refreshGenerations[provider] &&
      this.state.preferences.enabledSources[provider];
    const days = weekDays(this.state.anchor),
      shown = calendarDays(this.state.anchor, this.visibleDays),
      range = days[0];
    // Keep the full week for shared cache/right-panel consumers, while narrow
    // three-day views may extend beyond Sunday into the following week.
    const queryStart = shown[0] < range ? shown[0] : range;
    const lastShown = shown.at(-1) ?? days[6];
    const queryEnd = addDays(lastShown > days[6] ? lastShown : days[6], 1);
    this.set("sources", provider, { loading: true, error: undefined });
    try {
      const status = await providers.status(provider);
      if (!current()) return;
      this.set("sources", provider, "status", reconcile(status));
      if (!status.connected) {
        this.set("sources", provider, {
          calendars: [],
          items: [],
          updatedAt: undefined,
          range: undefined,
          error: status.error ?? "Reconnect this source.",
        });
        await this.persistCache();
        return;
      }
      const calendars = await providers.calendars(provider);
      if (!current()) return;
      this.set("sources", provider, "calendars", calendars);
      if (this.pruneCalendars(provider))
        await Promise.all([this.persistPreferences(), this.persistCache()]);
      if (!current()) return;
      const visible = new Set(this.visibleCalendars(provider).map((calendar) => calendar.id));
      const ids = this.state.preferences.selectedCalendars[provider].filter((id) =>
        visible.has(id),
      );
      const items = ids.length
        ? await providers.items(
            provider,
            ids,
            dateFromKey(queryStart).toISOString(),
            dateFromKey(queryEnd).toISOString(),
            Intl.DateTimeFormat().resolvedOptions().timeZone,
          )
        : [];
      if (!current()) return;
      this.set("sources", provider, {
        items,
        range,
        updatedAt: new Date().toISOString(),
        error: undefined,
      });
      await this.persistCache();
    } catch (error) {
      if (!current()) return;
      // A failed token refresh may have cleared native credentials. Only an
      // explicit disconnected result clears cache; network failures retain it.
      try {
        const status = await providers.status(provider);
        if (!current()) return;
        this.set("sources", provider, "status", reconcile(status));
        if (!status.connected) {
          this.set("sources", provider, {
            calendars: [],
            items: [],
            updatedAt: undefined,
            range: undefined,
          });
          await this.persistCache();
        }
      } catch {
        /* Preserve the last complete snapshot when status is unavailable. */
      }
      if (current()) this.set("sources", provider, "error", errorMessage(error));
    } finally {
      if (current()) this.set("sources", provider, "loading", false);
    }
  }
  private persistCache() {
    const sources = Object.fromEntries(
      PROVIDERS.map((provider) => [
        provider,
        {
          items: unwrap(this.state.sources[provider].items),
          updatedAt: this.state.sources[provider].updatedAt,
          range: this.state.sources[provider].range,
        },
      ]),
    );
    const content = JSON.stringify({ version: 1, sources });
    cacheQueue = cacheQueue
      .catch(() => {})
      .then(() => this.ctx.fs.writeFile("external-cache.json", content));
    return cacheQueue;
  }
  visible() {
    if (this.disposed) return () => {};
    if (++this.visibleCount === 1) {
      void this.refresh();
      this.pollTimer = setInterval(() => {
        if (document.visibilityState !== "hidden") void this.refresh();
      }, 5 * 60000);
      this.revisionTimer = setInterval(() => {
        if (
          this.revisionPending ||
          document.visibilityState === "hidden" ||
          (!this.state.preferences.enabledSources["apple-calendar"] &&
            !this.state.preferences.enabledSources["apple-reminders"])
        )
          return;
        this.revisionPending = true;
        void providers
          .appleRevision()
          .then((revision) => {
            if (this.disposed || !this.visibleCount) return;
            if (this.appleRevision !== -1 && revision !== this.appleRevision) {
              void this.refreshSource("apple-calendar");
              void this.refreshSource("apple-reminders");
            }
            this.appleRevision = revision;
          })
          .catch(() => {})
          .finally(() => {
            this.revisionPending = false;
          });
      }, 5000);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--this.visibleCount === 0) {
        clearInterval(this.pollTimer);
        clearInterval(this.revisionTimer);
      }
    };
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.writes.dispose();
    this.undo.clear();
    this.generation++;
    this.scanGeneration++;
    for (const provider of PROVIDERS) {
      this.connectionGenerations[provider]++;
      this.refreshGenerations[provider]++;
    }
    clearTimeout(this.scanTimer);
    clearInterval(this.pollTimer);
    clearInterval(this.revisionTimer);
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.connecting.clear();
    void providers.suspend().catch(() => {});
  }
}
const [getPlannerService, setPlannerService] = createSignal<PlannerService | null>(null);
export { getPlannerService, setPlannerService };
