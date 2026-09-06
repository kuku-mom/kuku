import type { PlannerTask, TaskMetadata, TaskPatch } from "~/lib/planner_tasks";
import { mkdir } from "~/lib/vault_fs";
import { mutateDocument, readCurrentDocument } from "~/plugins/document_mutations";
import type { PluginContext } from "~/plugins/types";

import { BINDINGS_PATH, readTimeBlockLinks, sameInstant, writeTimeBlockLinks } from "./bindings";
import { loadOperations, operationFailure, patchMatches, saveOperations } from "./operations";
import { providers } from "./providers";
import { localDate } from "./dates";
import {
  calendarKey,
  sameEventRef,
  type CalendarChoice,
  type EventRef,
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

type Token = { root: string; generation: number };
type TaskState = NonNullable<PendingOperation["taskState"]>;
interface WriteHost {
  ctx: PluginContext;
  state: {
    tasks: PlannerTask[];
    timeBlockLinks: TimeBlockLink[];
    operations: PendingOperation[];
    preferences: PlannerPreferences;
    sources: Record<Provider, SourceState>;
  };
  token(): Token;
  assertToken(token: Token): void;
  updateLocal(task: PlannerTask, patch: TaskPatch, expected?: TaskState): Promise<PlannerTask>;
  scan(): Promise<void>;
  setLinks(links: TimeBlockLink[]): void;
  setOperations(operations: PendingOperation[]): void;
  acceptItem(item: ExternalItem): void;
  removeItem(ref: EventRef): void;
  report(error: unknown): void;
}
const registryQueues = new Map<string, Promise<void>>();
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
function taskRef(task: PlannerTask): TaskRef {
  return { kind: "note", taskId: task.metadata?.id ?? task.id, path: task.path };
}
function localState(task: PlannerTask): TaskState {
  return {
    title: task.title,
    start: task.metadata?.scheduledStart,
    end: task.metadata?.scheduledEnd,
    checked: task.checked,
    dueDate: task.metadata?.dueDate,
  };
}
function snapshot(link: TimeBlockLink): TaskState {
  return {
    title: link.lastSync.taskTitle,
    start: link.lastSync.taskStart ?? link.lastSync.start,
    end: link.lastSync.taskEnd ?? link.lastSync.end,
    checked: link.lastSync.taskChecked,
    dueDate: link.lastSync.taskDueDate,
  };
}
function sameSchedule(a: TaskState, b: TaskState): boolean {
  return a.title === b.title && sameInstant(a.start, b.start) && sameInstant(a.end, b.end);
}
function validSchedule(value: TaskState) {
  return (
    !!value.start &&
    !!value.end &&
    Number.isFinite(Date.parse(value.start)) &&
    Date.parse(value.end) > Date.parse(value.start)
  );
}

/** Owns write-ahead recovery and binding synchronization. Explicit user writes
 * are serialized; a refresh can only synchronize an already registered link. */
export class PlannerWriteController {
  private tail: Promise<unknown> = Promise.resolve();
  private records: PendingOperation[] = [];
  private journalRoot: string | null = null;
  private epoch = 0;
  private sourceEpochs: Record<Provider, number> = {
    google: 0,
    "apple-calendar": 0,
    "apple-reminders": 0,
  };
  private syncQueued = false;
  private stopped = false;
  private host: WriteHost;
  private activeRun:
    | { token: Token; epoch: number; sourceEpochs: Record<Provider, number> }
    | undefined;
  constructor(host: WriteHost) {
    this.host = host;
  }
  private assertRun(provider?: Provider) {
    const run = this.activeRun;
    if (!run) return;
    this.host.assertToken(run.token);
    if (
      run.epoch !== this.epoch ||
      this.stopped ||
      (provider && run.sourceEpochs[provider] !== this.sourceEpochs[provider])
    )
      throw new Error("The connection changed during this operation.");
  }

  run<T>(action: () => Promise<T>): Promise<T> {
    const token = this.host.token();
    const run = { token, epoch: this.epoch, sourceEpochs: { ...this.sourceEpochs } };
    const result = this.tail
      .catch(() => {})
      .then(async () => {
        this.host.assertToken(token);
        if (this.stopped) throw new Error("Planner is disabled.");
        this.activeRun = run;
        try {
          return await action();
        } finally {
          this.activeRun = undefined;
        }
      });
    this.tail = result;
    return result;
  }
  reset() {
    this.epoch++;
    this.records = [];
    this.journalRoot = null;
    this.host.setOperations([]);
    this.host.setLinks([]);
  }
  disconnect(provider: Provider) {
    this.sourceEpochs[provider]++;
  }
  dispose() {
    this.stopped = true;
    this.epoch++;
  }

  async loadJournal() {
    const token = this.host.token();
    if (this.journalRoot === token.root) return;
    const epoch = this.epoch;
    const records = await loadOperations(this.host.ctx.fs, token.root);
    this.host.assertToken(token);
    if (epoch !== this.epoch) return;
    this.journalRoot = token.root;
    this.records = records;
    this.host.setOperations(copy(records));
  }
  private async persist(records = this.records, root = this.host.token().root) {
    await saveOperations(this.host.ctx.fs, root, records);
    if (!this.stopped && root === this.journalRoot && records === this.records)
      this.host.setOperations(copy(records));
  }
  private async registry(transform: (links: TimeBlockLink[]) => TimeBlockLink[]) {
    const token = this.host.token();
    const operation = (registryQueues.get(token.root) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        this.host.assertToken(token);
        let next: TimeBlockLink[] = [];
        const update = (markdown: string) => {
          this.host.assertToken(token);
          next = transform(readTimeBlockLinks(markdown));
          return writeTimeBlockLinks(markdown, next);
        };
        const exists = await this.host.ctx.vault.exists(BINDINGS_PATH);
        this.host.assertToken(token);
        if (exists) await mutateDocument(BINDINGS_PATH, update);
        else {
          // Do not create a registry merely by reading or removing nonexistent links.
          next = transform([]);
          if (!next.length) return;
          await mkdir("Calendar");
          this.host.assertToken(token);
          if (await this.host.ctx.vault.exists(BINDINGS_PATH))
            await mutateDocument(BINDINGS_PATH, update);
          else {
            this.host.assertToken(token);
            await this.host.ctx.vault.writeFile(
              BINDINGS_PATH,
              writeTimeBlockLinks("# Planner Links\n", next),
            );
          }
        }
        this.host.assertToken(token);
        this.host.setLinks(copy(next));
      });
    registryQueues.set(token.root, operation);
    try {
      await operation;
    } finally {
      if (registryQueues.get(token.root) === operation) registryQueues.delete(token.root);
    }
  }
  private async upsert(link: TimeBlockLink, confirmedFrom?: EventRef, replaceDeleted = false) {
    await this.registry((links) => {
      const old = links.find((value) => value.id === link.id);
      const confirmedReplacement =
        replaceDeleted && old && confirmedFrom && sameEventRef(old.eventRef, confirmedFrom);
      const confirmedMigration =
        old &&
        confirmedFrom &&
        sameEventRef(old.eventRef, confirmedFrom) &&
        old.eventRef.provider === link.eventRef.provider &&
        old.eventRef.calendarId === link.eventRef.calendarId &&
        !!old.eventRef.externalId &&
        old.eventRef.externalId === link.eventRef.externalId &&
        old.eventRef.occurrence === link.eventRef.occurrence;
      if (
        old &&
        ((!sameEventRef(old.eventRef, link.eventRef) &&
          !confirmedMigration &&
          !confirmedReplacement) ||
          old.task.kind !== link.task.kind ||
          (old.task.kind === "note" &&
            link.task.kind === "note" &&
            old.task.taskId !== link.task.taskId))
      )
        throw new Error("CONFLICT: This binding was changed in another document edit.");
      return [...links.filter((value) => value.id !== link.id), copy(link)];
    });
  }
  private async removeLink(id: string) {
    await this.registry((links) => links.filter((link) => link.id !== id));
  }
  private requireSource(provider: Provider, calendarId: string) {
    const source = this.host.state.sources[provider];
    if (!this.host.state.preferences.enabledSources[provider] || !source.status.connected)
      throw new Error("AUTH: Reconnect this source before writing.");
    if (
      source.status.writable !== true ||
      !source.calendars.some((calendar) => calendar.id === calendarId && calendar.writable === true)
    )
      throw new Error("READ_ONLY: Select a writable calendar or reconnect with editing access.");
    this.requirePreferred(provider, calendarId);
  }
  private requirePreferred(provider: Provider, calendarId: string) {
    const alias = this.host.state.preferences.calendarAliases?.[calendarKey(provider, calendarId)];
    const preferred = alias && this.host.state.preferences.preferredConnectors?.[alias];
    if (preferred && preferred !== provider)
      throw new Error("READ_ONLY: This calendar uses a different preferred connector.");
  }
  private requireReadable(ref: EventRef) {
    const source = this.host.state.sources[ref.provider];
    if (!this.host.state.preferences.enabledSources[ref.provider] || !source.status.connected)
      throw new Error("AUTH: Reconnect the linked source.");
    if (!source.calendars.some((calendar) => calendar.id === ref.calendarId))
      throw new Error(
        "NOT_FOUND: The linked calendar is not available in this connection. Its task and block were preserved.",
      );
    this.requirePreferred(ref.provider, ref.calendarId);
  }
  private itemRef(item: ExternalItem): EventRef {
    if (
      !item.writeRef ||
      item.writable !== true ||
      item.writeRef.provider !== item.provider ||
      item.writeRef.calendarId !== item.calendarId
    )
      throw new Error("READ_ONLY: This item cannot be edited. Refresh or reconnect the source.");
    return copy(item.writeRef);
  }
  private note(ref: Extract<TaskRef, { kind: "note" }>, linkId?: string): PlannerTask {
    const matches = this.host.state.tasks.filter((task) => task.metadata?.id === ref.taskId);
    if (matches.length !== 1)
      throw new Error(
        matches.length
          ? "CONFLICT: Duplicate task ID; no external item was changed."
          : "NOT_FOUND: The linked task is missing.",
      );
    const task = matches[0];
    if (linkId) {
      const copies = this.host.state.tasks.filter(
        (value) => value.metadata?.timeBlockLinkId === linkId,
      );
      if (
        copies.length > 1 ||
        (task.metadata?.timeBlockLinkId && task.metadata.timeBlockLinkId !== linkId)
      )
        throw new Error(
          "CONFLICT: Duplicate or changed task binding; no external item was changed.",
        );
    }
    return task;
  }
  timeBlockForTask(task: PlannerTask | ExternalItem): TimeBlockLink | undefined {
    if ("path" in task)
      return this.host.state.timeBlockLinks.find(
        (link) => link.task.kind === "note" && link.task.taskId === task.metadata?.id,
      );
    return task.writeRef
      ? this.host.state.timeBlockLinks.find(
          (link) =>
            link.task.kind === "reminder" && sameEventRef(link.task.eventRef, task.writeRef!),
        )
      : undefined;
  }
  linkedTask(item: ExternalItem): PlannerTask | ExternalItem | null {
    const link =
      item.writeRef &&
      this.host.state.timeBlockLinks.find((value) => sameEventRef(value.eventRef, item.writeRef!));
    if (!link) return null;
    if (link.task.kind === "note") {
      try {
        return this.note(link.task, link.id);
      } catch {
        return null;
      }
    }
    const ref = link.task.eventRef;
    return (
      this.host.state.sources[ref.provider].items.find(
        (value) => value.writeRef && sameEventRef(value.writeRef, ref),
      ) ?? null
    );
  }
  private bindingForItem(item: ExternalItem) {
    return item.writeRef
      ? this.host.state.timeBlockLinks.find((link) => sameEventRef(link.eventRef, item.writeRef!))
      : undefined;
  }

  private async newOperation(
    input: Omit<PendingOperation, "id" | "status" | "attempts" | "createdAt" | "stage">,
  ): Promise<ExternalItem | null> {
    const token = this.activeRun?.token ?? this.host.token(),
      epoch = this.activeRun?.epoch ?? this.epoch,
      sourceEpoch =
        this.activeRun?.sourceEpochs[input.provider] ?? this.sourceEpochs[input.provider];
    const current = () => {
      this.assertRun(input.provider);
      if (input.task?.kind === "reminder") this.assertRun(input.task.eventRef.provider);
      this.host.assertToken(token);
      if (epoch !== this.epoch || sourceEpoch !== this.sourceEpochs[input.provider] || this.stopped)
        throw new Error("The connection changed before the external operation started.");
    };
    await this.loadJournal();
    current();
    if (input.linkId && this.records.some((operation) => operation.linkId === input.linkId))
      throw new Error(
        "This time block has a pending operation. Retry or dismiss it before editing again.",
      );
    if (
      input.task &&
      this.records.some(
        (operation) =>
          operation.task &&
          (input.task!.kind === "note" && operation.task.kind === "note"
            ? input.task!.taskId === operation.task.taskId
            : input.task!.kind === "reminder" &&
              operation.task.kind === "reminder" &&
              sameEventRef(input.task!.eventRef, operation.task.eventRef)),
      )
    )
      throw new Error(
        "This task already has a pending time-block operation. Recover it before publishing another block.",
      );
    this.requireSource(input.provider, input.calendarId);
    const hasRegistry = input.linkId && (await this.host.ctx.vault.exists(BINDINGS_PATH));
    current();
    if (hasRegistry) {
      const links = readTimeBlockLinks(await readCurrentDocument(BINDINGS_PATH));
      current();
      const existing = links.find((link) => link.id === input.linkId);
      if (input.eventRef && (!existing || !sameEventRef(existing.eventRef, input.eventRef)))
        throw new Error("CONFLICT: The task binding changed before the external edit.");
    }
    const operation: PendingOperation = {
      ...copy(input),
      id: crypto.randomUUID(),
      status: "pending",
      attempts: 0,
      createdAt: new Date().toISOString(),
      stage: "remote",
    };
    this.records.push(operation);
    try {
      await this.persist();
    } catch (error) {
      const index = this.records.indexOf(operation);
      if (index >= 0) this.records.splice(index, 1);
      this.host.setOperations(copy(this.records));
      throw error;
    }
    current();
    return this.execute(operation);
  }
  private async remote(operation: PendingOperation): Promise<ExternalItem | null> {
    if (operation.type === "create")
      return providers.create(
        operation.provider,
        operation.calendarId,
        operation.draft!,
        operation.id,
      );
    if (operation.attempts > 1) {
      const current = await providers.get(operation.eventRef!);
      if (operation.type === "delete" && current === null) return null;
      if (!current) throw new Error("NOT_FOUND: The external item was deleted.");
      if (operation.type === "update" && patchMatches(current, operation.patch!)) return current;
      if (!current.writeRef || current.writeRef.version !== operation.eventRef!.version)
        throw new Error(
          "CONFLICT: The external item changed. Refresh and resolve the pending edit.",
        );
    }
    if (operation.type === "update")
      return providers.update(operation.eventRef!, operation.patch!, operation.id);
    await providers.delete(operation.eventRef!, operation.id);
    return null;
  }
  private async execute(operation: PendingOperation): Promise<ExternalItem | null> {
    const token = this.host.token(),
      records = this.records;
    const epoch = this.epoch,
      sourceEpoch = this.sourceEpochs[operation.provider];
    const current = () => {
      this.assertRun(operation.provider);
      if (operation.task?.kind === "reminder") this.assertRun(operation.task.eventRef.provider);
      this.host.assertToken(token);
      if (
        epoch !== this.epoch ||
        sourceEpoch !== this.sourceEpochs[operation.provider] ||
        this.stopped
      )
        throw new Error("The connection changed. The operation remains in the retry journal.");
      this.requireSource(operation.provider, operation.calendarId);
    };
    try {
      current();
      if (
        operation.task?.kind === "note" &&
        !operation.cleanupResult &&
        operation.type !== "delete"
      )
        this.note(operation.task, operation.linkId);
      operation.status = "pending";
      operation.error = undefined;
      if (operation.stage === "remote") {
        operation.attempts++;
        await this.persist(records, token.root);
        current();
        operation.result = await this.remote(operation);
        operation.stage = "local";
        // Save a confirmed response even if the user switched vaults/disconnected
        // while native was running. Only this original vault's journal is touched.
        await this.persist(records, token.root);
      }
      current();
      const result = operation.result ?? null;
      if (operation.cleanupResult && result?.writeRef) {
        const existing = await providers.get(result.writeRef);
        current();
        if (existing) {
          if (!existing.writeRef || existing.writeRef.version !== result.writeRef.version)
            throw new Error("CONFLICT: The created event changed before cleanup.");
          await providers.delete(existing.writeRef, `${operation.id}-cleanup`);
          current();
        }
        this.host.removeItem(result.writeRef);
        if (operation.linkId) await this.removeLink(operation.linkId);
      } else await this.finish(operation, result);
      current();
      const index = records.indexOf(operation);
      if (index >= 0) records.splice(index, 1);
      await this.persist(records, token.root);
      return result;
    } catch (error) {
      operation.status = operationFailure(error);
      operation.error = message(error);
      await this.persist(records, token.root).catch(() => {});
      if (
        !this.stopped &&
        records === this.records &&
        token.root === this.journalRoot &&
        operation.linkId
      )
        this.host.setLinks(
          this.host.state.timeBlockLinks.map((link) =>
            link.id === operation.linkId
              ? {
                  ...copy(link),
                  status: operation.status === "conflict" ? "conflict" : "pending",
                  error: operation.error,
                }
              : copy(link),
          ),
        );
      throw error;
    }
  }
  private async finish(operation: PendingOperation, result: ExternalItem | null) {
    const binding =
      operation.linkId &&
      this.host.state.timeBlockLinks.find((link) => link.id === operation.linkId);
    if (operation.type === "delete") {
      if (operation.eventRef) this.host.removeItem(operation.eventRef);
      if (binding) await this.clearBinding(binding, operation.taskState);
      return;
    }
    if (!result) throw new Error("The provider returned no saved item.");
    this.host.acceptItem(result);
    if (!operation.linkId || !operation.task) return;
    if (!result.writeRef || !result.start || !result.end || result.allDay)
      throw new Error("The provider did not return a usable timed block reference.");
    if (operation.origin === "event" && binding) {
      await this.pullEvent(binding, result);
      return;
    }
    let ref = operation.task;
    if (ref.kind === "note") {
      const task = this.note(ref, operation.linkId);
      if (task.metadata?.timeBlockLinkId !== operation.linkId)
        await this.host.updateLocal(task, { metadata: { timeBlockLinkId: operation.linkId } });
      ref = taskRef(task);
    }
    const state = operation.taskState ?? {
      title: result.title,
      start: result.start,
      end: result.end,
    };
    await this.upsert(
      this.makeBinding(operation.linkId, ref, result, state),
      operation.eventRef,
      operation.type === "create" && !!operation.eventRef,
    );
  }
  private makeBinding(
    id: string,
    task: TaskRef,
    item: ExternalItem,
    state: TaskState,
  ): TimeBlockLink {
    return {
      id,
      task: copy(task),
      eventRef: copy(item.writeRef!),
      title: item.title,
      start: item.start!,
      end: item.end!,
      timeZone: item.timeZone,
      status: "synced",
      syncedAt: new Date().toISOString(),
      lastSync: {
        title: item.title,
        start: item.start!,
        end: item.end!,
        taskTitle: state.title,
        taskStart: state.start,
        taskEnd: state.end,
        taskChecked: state.checked,
        taskDueDate: state.dueDate,
      },
    };
  }
  private async clearBinding(link: TimeBlockLink, expected = snapshot(link)) {
    if (link.task.kind === "note") {
      let task: PlannerTask | undefined;
      try {
        task = this.note(link.task, link.id);
      } catch (error) {
        if (!message(error).startsWith("NOT_FOUND:")) throw error;
      }
      if (task) {
        if (!sameSchedule(localState(task), expected))
          throw new Error("CONFLICT: The task changed while its calendar block was being removed.");
        await this.host.updateLocal(
          task,
          {
            metadata: {
              scheduledStart: undefined,
              scheduledEnd: undefined,
              timeZone: undefined,
              timeBlockLinkId: undefined,
            },
          },
          expected,
        );
      }
    }
    await this.removeLink(link.id);
  }
  private async pullEvent(link: TimeBlockLink, item: ExternalItem, expected = snapshot(link)) {
    this.assertRun(link.eventRef.provider);
    if (!item.start || !item.end || item.allDay || !item.writeRef)
      throw new Error("CONFLICT: The linked calendar block is no longer a timed event.");
    if (link.task.kind === "note") {
      const task = this.note(link.task, link.id);
      if (!sameSchedule(localState(task), expected))
        throw new Error("CONFLICT: Both the task and its calendar block changed.");
      const updated = await this.host.updateLocal(
        task,
        {
          title: item.title,
          metadata: {
            scheduledStart: item.start,
            scheduledEnd: item.end,
            plannedDate: localDate(new Date(item.start)),
            timeZone: item.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
            timeBlockLinkId: link.id,
          },
        },
        expected,
      );
      await this.upsert(
        this.makeBinding(link.id, taskRef(updated), item, localState(updated)),
        link.eventRef,
      );
    } else {
      let reminder = await providers.get(link.task.eventRef);
      this.assertRun(link.eventRef.provider);
      this.assertRun(link.task.eventRef.provider);
      if (!reminder?.writeRef) throw new Error("NOT_FOUND: The linked reminder is missing.");
      if (reminder.title !== expected.title && reminder.title !== item.title)
        throw new Error("CONFLICT: Both the reminder and calendar block titles changed.");
      if (reminder.title !== item.title) {
        this.requireSource(reminder.provider, reminder.calendarId);
        reminder = (await this.newOperation({
          type: "update",
          provider: reminder.provider,
          calendarId: reminder.calendarId,
          eventRef: this.itemRef(reminder),
          patch: { title: item.title },
          origin: "standalone",
        }))!;
      }
      await this.upsert(
        this.makeBinding(link.id, { kind: "reminder", eventRef: reminder.writeRef! }, item, {
          title: item.title,
          start: item.start,
          end: item.end,
          checked: reminder.completed,
          dueDate: reminder.dueDate,
        }),
        link.eventRef,
      );
    }
  }

  async createItem(
    provider: Provider,
    calendarId: string,
    draft: ItemDraft,
  ): Promise<ExternalItem> {
    return (await this.newOperation({
      type: "create",
      provider,
      calendarId,
      draft,
      origin: "standalone",
    }))!;
  }
  async updateItem(item: ExternalItem, patch: ItemPatch): Promise<ExternalItem> {
    const ref = this.itemRef(item),
      link = this.bindingForItem(item);
    const result = await this.newOperation({
      type: "update",
      provider: item.provider,
      calendarId: item.calendarId,
      eventRef: ref,
      patch,
      origin: link ? "event" : "standalone",
      linkId: link?.id,
      task: link?.task,
    });
    return result!;
  }
  async deleteItem(item: ExternalItem) {
    const ref = this.itemRef(item),
      link = this.bindingForItem(item);
    await this.newOperation({
      type: "delete",
      provider: item.provider,
      calendarId: item.calendarId,
      eventRef: ref,
      origin: "event",
      linkId: link?.id,
      task: link?.task,
    });
    if (item.kind === "reminder") {
      const taskLink = this.timeBlockForTask(item);
      if (taskLink) await this.removeLink(taskLink.id);
    }
  }
  async publishTask(task: PlannerTask, scheduleExplicit: boolean) {
    const link = this.timeBlockForTask(task);
    if (!link && !scheduleExplicit) return;
    if (!link && task.metadata?.timeBlockLinkId)
      throw new Error(
        "CONFLICT: This task references a missing time-block binding. Restore Planner Links before publishing.",
      );
    if (link && task.metadata?.timeBlockLinkId !== link.id)
      throw new Error(
        "CONFLICT: The task binding metadata was removed or changed. Resolve the binding before publishing.",
      );
    const state = localState(task);
    if (link && !validSchedule(state)) {
      await this.newOperation({
        type: "delete",
        provider: link.eventRef.provider,
        calendarId: link.eventRef.calendarId,
        eventRef: link.eventRef,
        origin: "task",
        linkId: link.id,
        task: taskRef(task),
        taskState: state,
      });
      return;
    }
    if (!validSchedule(state)) return;
    if (link && sameSchedule(state, snapshot(link))) return;
    const choice = link
      ? { provider: link.eventRef.provider, calendarId: link.eventRef.calendarId }
      : this.host.state.preferences.defaultCalendar;
    if (!choice) return;
    this.requireSource(choice.provider, choice.calendarId);
    const id = link?.id ?? task.metadata?.timeBlockLinkId ?? crypto.randomUUID();
    const draft: ItemDraft = {
      title: state.title,
      start: state.start,
      end: state.end,
      allDay: false,
      timeZone: task.metadata?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
    await this.newOperation({
      type: link ? "update" : "create",
      provider: choice.provider,
      calendarId: choice.calendarId,
      eventRef: link?.eventRef,
      draft: link ? undefined : draft,
      patch: link ? draft : undefined,
      origin: "task",
      linkId: id,
      task: taskRef(task),
      taskState: state,
    });
  }
  async scheduleReminder(item: ExternalItem, metadata: Partial<TaskMetadata>) {
    if (item.kind !== "reminder" || item.provider !== "apple-reminders")
      throw new Error("Choose an Apple reminder.");
    const ref = this.itemRef(item),
      link = this.timeBlockForTask(item);
    this.requireSource(item.provider, item.calendarId);
    const state: TaskState = {
      title: item.title,
      start: metadata.scheduledStart,
      end: metadata.scheduledEnd,
      checked: item.completed,
      dueDate: item.dueDate,
    };
    if (!validSchedule(state)) {
      if (state.start || state.end) throw new Error("Choose a valid start and end time.");
      if (link)
        await this.newOperation({
          type: "delete",
          provider: link.eventRef.provider,
          calendarId: link.eventRef.calendarId,
          eventRef: link.eventRef,
          origin: "task",
          linkId: link.id,
          task: link.task,
        });
      return;
    }
    const choice: CalendarChoice | { provider: Provider; calendarId: string } | null | undefined =
      link ? link.eventRef : this.host.state.preferences.defaultCalendar;
    if (!choice) throw new Error("Select a default calendar before scheduling a reminder.");
    const draft: ItemDraft = {
      title: item.title,
      start: state.start,
      end: state.end,
      allDay: false,
      timeZone: metadata.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
    await this.newOperation({
      type: link ? "update" : "create",
      provider: choice.provider,
      calendarId: choice.calendarId,
      eventRef: link?.eventRef,
      draft: link ? undefined : draft,
      patch: link ? draft : undefined,
      origin: "task",
      linkId: link?.id ?? crypto.randomUUID(),
      task: { kind: "reminder", eventRef: ref },
      taskState: state,
    });
  }
  async beforeDeleteTask(task: PlannerTask, deleteBlock: boolean) {
    await this.loadJournal();
    const pending = this.records.find(
      (operation) => operation.task?.kind === "note" && operation.task.taskId === task.metadata?.id,
    );
    if (pending) {
      if (deleteBlock && pending.type === "create") {
        pending.cleanupResult = true;
        await this.persist();
        await this.execute(pending);
      } else throw new Error("Resolve the pending time-block operation before deleting this task.");
    }
    const link = this.timeBlockForTask(task);
    if (!link) return;
    if (deleteBlock)
      await this.newOperation({
        type: "delete",
        provider: link.eventRef.provider,
        calendarId: link.eventRef.calendarId,
        eventRef: link.eventRef,
        origin: "task",
        linkId: link.id,
        task: link.task,
        taskState: localState(task),
      });
    // Keeping the event must not detach it until the source document accepted
    // its deletion. A protected or stale document can reject that mutation.
  }
  async afterDeleteTask(task: PlannerTask) {
    const link = this.timeBlockForTask(task);
    if (link) await this.removeLink(link.id);
  }
  async retryOperation(id: string, reviewedVersion?: string) {
    const token = this.activeRun?.token ?? this.host.token(),
      epoch = this.activeRun?.epoch ?? this.epoch;
    await this.loadJournal();
    this.host.assertToken(token);
    const operation = this.records.find((value) => value.id === id);
    if (!operation) return;
    const sourceEpoch =
      this.activeRun?.sourceEpochs[operation.provider] ?? this.sourceEpochs[operation.provider];
    const current = () => {
      this.host.assertToken(token);
      if (
        epoch !== this.epoch ||
        sourceEpoch !== this.sourceEpochs[operation.provider] ||
        this.stopped
      )
        throw new Error("The connection changed before the retry started.");
    };
    current();
    if (
      operation.type !== "create" &&
      operation.origin === "task" &&
      operation.task?.kind === "note" &&
      operation.taskState &&
      !sameSchedule(localState(this.note(operation.task, operation.linkId)), operation.taskState)
    )
      throw new Error(
        "CONFLICT: The task changed after this operation was queued. Review the current task before retrying.",
      );
    if (reviewedVersion && operation.eventRef) {
      this.requireReadable(operation.eventRef);
      const current = await providers.get(operation.eventRef);
      this.host.assertToken(token);
      if (
        epoch !== this.epoch ||
        sourceEpoch !== this.sourceEpochs[operation.provider] ||
        this.stopped
      )
        throw new Error("The connection changed during review.");
      if (!current?.writeRef || current.writeRef.version !== reviewedVersion)
        throw new Error("CONFLICT: The external item changed after the review. Review it again.");
      operation.eventRef = copy(current.writeRef);
      if (operation.stage === "remote") {
        operation.status = "pending";
        operation.error = undefined;
      }
      await this.persist();
    }
    current();
    return this.execute(operation);
  }
  async dismissOperation(id: string) {
    await this.loadJournal();
    const operation = this.records.find((value) => value.id === id);
    if (!operation) return;
    if (operation.stage === "local" && operation.result && operation.linkId)
      throw new Error(
        "The external item was saved. Retry to finish linking it before dismissing this operation.",
      );
    if (operation.type === "create" && operation.attempts > 0)
      throw new Error(
        "The create result is uncertain. Retry with its saved operation ID before dismissing it.",
      );
    this.records.splice(this.records.indexOf(operation), 1);
    await this.persist();
  }
  async resolveLink(
    id: string,
    choice: "task" | "event",
    reviewedVersion?: string,
    reviewedTask?: { title: string; start?: string; end?: string },
  ) {
    await this.loadJournal();
    this.assertRun();
    const previous = this.records.filter((operation) => operation.linkId === id);
    if (previous.some((operation) => operation.stage !== "local"))
      throw new Error("Recover the uncertain external operation before resolving this binding.");
    const token = this.host.token();
    const link = this.host.state.timeBlockLinks.find((value) => value.id === id);
    if (!link) throw new Error("This binding is no longer available.");
    const current = () => {
      this.assertRun(link.eventRef.provider);
      this.requireReadable(link.eventRef);
      if (link.task.kind === "reminder") {
        this.assertRun(link.task.eventRef.provider);
        this.requireReadable(link.task.eventRef);
      }
    };
    current();
    this.requireReadable(link.eventRef);
    let task: PlannerTask | undefined,
      reminder: ExternalItem | null = null,
      state: TaskState;
    if (link.task.kind === "note") {
      task = this.note(link.task, link.id);
      state = localState(task);
    } else {
      this.requireReadable(link.task.eventRef);
      reminder = await providers.get(link.task.eventRef);
      this.host.assertToken(token);
      current();
      if (!reminder?.writeRef) throw new Error("The reminder is no longer available.");
      state = {
        title: reminder.title,
        start: link.start,
        end: link.end,
        checked: reminder.completed,
        dueDate: reminder.dueDate,
      };
    }
    if (!reviewedTask || !sameSchedule(state, reviewedTask))
      throw new Error("CONFLICT: The task changed after the review. Review both versions again.");
    const event = await providers.get(link.eventRef);
    this.host.assertToken(token);
    current();
    // Recheck local ownership after the native read yielded to the editor.
    if (
      task &&
      !sameSchedule(
        localState(this.note(link.task as Extract<TaskRef, { kind: "note" }>, link.id)),
        reviewedTask,
      )
    )
      throw new Error("CONFLICT: The task changed after the review.");
    if (
      event &&
      (!event.writeRef || !reviewedVersion || event.writeRef.version !== reviewedVersion)
    )
      throw new Error("CONFLICT: The calendar item changed after the review.");
    if (!event && reviewedVersion)
      throw new Error("CONFLICT: The calendar item was deleted after the review.");
    // The user reviewed both current values and replaces an earlier local-only
    // completion intent. The remote outcome is already confirmed and the
    // registry still identifies it, so resolving can safely supersede it.
    if (previous.length) {
      for (const operation of previous) {
        const index = this.records.indexOf(operation);
        if (index >= 0) this.records.splice(index, 1);
      }
      await this.persist();
      current();
    }
    if (!event) {
      if (choice === "event") {
        await this.clearBinding(link, state);
        return;
      }
      if (!validSchedule(state)) {
        await this.clearBinding(link, state);
        return;
      }
      this.requireSource(link.eventRef.provider, link.eventRef.calendarId);
      const draft: ItemDraft = {
        title: state.title,
        start: state.start,
        end: state.end,
        allDay: false,
        timeZone: link.timeZone,
      };
      await this.newOperation({
        type: "create",
        provider: link.eventRef.provider,
        calendarId: link.eventRef.calendarId,
        eventRef: link.eventRef,
        draft,
        origin: "task",
        linkId: link.id,
        task: task ? taskRef(task) : { kind: "reminder", eventRef: reminder!.writeRef! },
        taskState: state,
      });
      return;
    }
    if (!event.start || !event.end || event.allDay)
      throw new Error("The linked event must remain a timed block.");
    if (choice === "event") {
      await this.pullEvent(link, event, state);
    } else {
      const rebased: TimeBlockLink = {
        ...copy(link),
        eventRef: event.writeRef!,
        title: event.title,
        start: event.start,
        end: event.end,
        timeZone: event.timeZone,
        status: "synced",
        error: undefined,
        lastSync: {
          ...copy(link.lastSync),
          title: event.title,
          start: event.start,
          end: event.end,
          taskTitle: event.title,
          taskStart: event.start,
          taskEnd: event.end,
        },
      };
      await this.upsert(rebased, link.eventRef);
      if (task)
        await this.publishTask(
          this.note(taskRef(task) as Extract<TaskRef, { kind: "note" }>, link.id),
          false,
        );
      else
        await this.scheduleReminder(reminder!, {
          scheduledStart: state.start,
          scheduledEnd: state.end,
          timeZone: link.timeZone,
        });
    }
  }
  queueSync() {
    if (
      this.syncQueued ||
      this.stopped ||
      !this.host.state.timeBlockLinks.length ||
      !this.host.ctx.vault.rootPath
    )
      return;
    this.syncQueued = true;
    void this.run(async () => {
      this.syncQueued = false;
      await this.sync();
    }).catch((error) => {
      this.syncQueued = false;
      this.host.report(error);
    });
  }
  async sync() {
    await this.loadJournal();
    const token = this.host.token();
    for (const original of [...this.host.state.timeBlockLinks]) {
      this.host.assertToken(token);
      if (this.stopped || this.records.some((operation) => operation.linkId === original.id))
        continue;
      const source = this.host.state.sources[original.eventRef.provider];
      if (
        !source.status.connected ||
        !this.host.state.preferences.enabledSources[original.eventRef.provider]
      )
        continue;
      const epoch = this.sourceEpochs[original.eventRef.provider];
      try {
        this.requireReadable(original.eventRef);
        let state: TaskState;
        let task: PlannerTask | undefined;
        let ref = original.task;
        if (ref.kind === "note") {
          task = this.note(ref, original.id);
          if (task.metadata?.timeBlockLinkId !== original.id)
            throw new Error("CONFLICT: The task binding metadata was removed.");
          state = localState(task);
          ref = taskRef(task);
        } else {
          if (!this.host.state.preferences.enabledSources[ref.eventRef.provider]) continue;
          this.requireReadable(ref.eventRef);
          const reminder = await providers.get(ref.eventRef);
          this.host.assertToken(token);
          if (!reminder?.writeRef) throw new Error("NOT_FOUND: The linked reminder is missing.");
          state = {
            title: reminder.title,
            start: original.start,
            end: original.end,
            checked: reminder.completed,
            dueDate: reminder.dueDate,
          };
          ref = { kind: "reminder", eventRef: reminder.writeRef };
        }
        const remote = await providers.get(original.eventRef);
        this.host.assertToken(token);
        if (epoch !== this.sourceEpochs[original.eventRef.provider] || this.stopped) continue;
        this.requireReadable(original.eventRef);
        if (original.task.kind === "reminder") {
          this.assertRun(original.task.eventRef.provider);
          this.requireReadable(original.task.eventRef);
        }
        const localChanged = !sameSchedule(state, snapshot(original));
        if (!remote) {
          if (localChanged)
            throw new Error("CONFLICT: The calendar block was deleted while its task changed.");
          await this.clearBinding(original);
          continue;
        }
        if (!remote.writeRef || !remote.start || !remote.end || remote.allDay)
          throw new Error("CONFLICT: The linked block is no longer a timed event.");
        if (!sameEventRef(remote.writeRef, original.eventRef)) {
          this.host.removeItem(original.eventRef);
          this.host.acceptItem(remote);
        }
        const remoteState = { title: remote.title, start: remote.start, end: remote.end };
        const remoteChanged = !sameSchedule(remoteState, {
          title: original.lastSync.title,
          start: original.lastSync.start,
          end: original.lastSync.end,
        });
        if (localChanged && remoteChanged && !sameSchedule(state, remoteState))
          throw new Error("CONFLICT: Both the task and calendar block changed.");
        if (localChanged && !remoteChanged) {
          if (task) {
            await this.upsert({ ...copy(original), eventRef: remote.writeRef }, original.eventRef);
            await this.publishTask(task, false);
          } else {
            const draft = {
              title: state.title,
              start: state.start!,
              end: state.end!,
              allDay: false,
              timeZone: original.timeZone,
            };
            await this.newOperation({
              type: "update",
              provider: remote.provider,
              calendarId: remote.calendarId,
              eventRef: remote.writeRef,
              patch: draft,
              origin: "task",
              linkId: original.id,
              task: ref,
              taskState: state,
            });
          }
        } else if (remoteChanged && !localChanged) await this.pullEvent(original, remote);
        else {
          const next = this.makeBinding(original.id, ref, remote, state);
          // Avoid save/scan feedback loops when no meaningful field changed.
          if (
            JSON.stringify({ ...original, syncedAt: undefined }) !==
            JSON.stringify({ ...next, syncedAt: undefined })
          )
            await this.upsert(next, original.eventRef);
        }
      } catch (error) {
        this.host.assertToken(token);
        if (epoch !== this.sourceEpochs[original.eventRef.provider] || this.stopped) continue;
        const status = message(error).startsWith("NOT_FOUND:")
          ? "missing"
          : operationFailure(error) === "conflict"
            ? "conflict"
            : "pending";
        const next = { ...copy(original), status, error: message(error) } as TimeBlockLink;
        this.host.setLinks(
          this.host.state.timeBlockLinks.map((link) =>
            link.id === original.id ? next : copy(link),
          ),
        );
      }
    }
  }
}
