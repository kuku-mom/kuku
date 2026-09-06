import { createSignal, type Accessor, type Setter } from "solid-js";

import type { PlannerTask, TaskMetadata, TaskPatch } from "~/lib/planner_tasks";

import { providers } from "./providers";
import {
  sameEventRef,
  type CalendarChoice,
  type EventRef,
  type ExternalItem,
  type ItemPatch,
  type PendingOperation,
  type PlannerPreferences,
  type Provider,
  type SourceState,
  type TimeBlockLink,
} from "./types";

export type PlannerUndoErrorCode = "changed" | "pending" | "calendar" | "unavailable" | "busy";
export class PlannerUndoError extends Error {
  readonly code: PlannerUndoErrorCode;
  constructor(code: PlannerUndoErrorCode) {
    super(`Planner undo: ${code}`);
    this.name = "PlannerUndoError";
    this.code = code;
  }
}
export interface PlannerUndoEntry {
  id: string;
  label: string;
  /** An unscheduled external block is recreated with a new provider identity. */
  recreatesBlock: boolean;
}
interface UndoHost {
  state: {
    tasks: readonly PlannerTask[];
    timeBlockLinks: readonly TimeBlockLink[];
    operations: readonly PendingOperation[];
    preferences: PlannerPreferences;
    sources: Record<Provider, SourceState>;
  };
  updateTask(task: PlannerTask, patch: TaskPatch, expected?: PlannerTask): Promise<PlannerTask>;
  updateItem(item: ExternalItem, patch: ItemPatch): Promise<ExternalItem>;
  scheduleReminder(item: ExternalItem, metadata: Partial<TaskMetadata>): Promise<unknown>;
  deleteItem(item: ExternalItem): Promise<unknown>;
  timeBlockForTask(task: PlannerTask | ExternalItem): TimeBlockLink | undefined;
  linkedTask(item: ExternalItem): PlannerTask | ExternalItem | null;
}
interface UndoRecord extends PlannerUndoEntry {
  revert: (assertCurrent: () => void) => Promise<void>;
}
interface TaskSnapshot {
  task: PlannerTask;
  link?: TimeBlockLink;
  calendar: CalendarChoice | null;
}
interface ReminderSnapshot {
  item: ExternalItem;
  link?: TimeBlockLink;
  calendar: CalendarChoice | null;
}

// Store values, not reactive proxies: later refreshes must not mutate history.
function copy<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}
function canonical(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`;
}
function same(a: unknown, b: unknown) {
  return canonical(a) === canonical(b);
}
function taskValue(task: PlannerTask) {
  return { title: task.title, checked: task.checked, metadata: task.metadata };
}
function itemValue(item: ExternalItem) {
  return {
    title: item.title,
    kind: item.kind,
    start: item.start,
    end: item.end,
    allDay: item.allDay,
    timeZone: item.timeZone,
    completed: item.completed,
    dueDate: item.dueDate,
    location: item.location,
    description: item.description,
  };
}
function linkValue(link: TimeBlockLink | undefined) {
  if (!link) return null;
  return {
    id: link.id,
    title: link.title,
    start: link.start,
    end: link.end,
    timeZone: link.timeZone,
    status: link.status,
    eventRef: {
      provider: link.eventRef.provider,
      calendarId: link.eventRef.calendarId,
      itemId: link.eventRef.itemId,
      occurrence: link.eventRef.occurrence,
    },
  };
}
function taskInverse(before: PlannerTask, after: PlannerTask): TaskPatch {
  const patch: TaskPatch = {};
  if (before.title !== after.title) patch.title = before.title;
  if (before.checked !== after.checked) patch.checked = before.checked;
  const metadata: Record<string, unknown> = {};
  for (const key of new Set([
    ...Object.keys(before.metadata ?? {}),
    ...Object.keys(after.metadata ?? {}),
  ])) {
    // Stable task identity survives undo; the service owns binding identities.
    if (key === "id" || key === "timeBlockLinkId") continue;
    const oldValue = (before.metadata as unknown as Record<string, unknown> | null)?.[key];
    const newValue = (after.metadata as unknown as Record<string, unknown> | null)?.[key];
    if (!same(oldValue, newValue)) metadata[key] = oldValue;
  }
  if (Object.keys(metadata).length) patch.metadata = metadata as Partial<TaskMetadata>;
  return patch;
}
function requestedTaskInverse(
  before: PlannerTask,
  after: PlannerTask,
  requested: TaskPatch,
): TaskPatch | null {
  const inverse = taskInverse(before, after);
  const intendedTitle = requested.title?.replace(/\s+/g, " ").trim();
  if (intendedTitle === undefined || intendedTitle === before.title) delete inverse.title;
  else if (after.title !== intendedTitle) return null;
  if (requested.checked === undefined || requested.checked === before.checked)
    delete inverse.checked;
  else if (after.checked !== requested.checked) return null;
  const intendedMetadata = new Set<string>();
  const oldMetadata = before.metadata as unknown as Record<string, unknown> | null;
  const newMetadata = after.metadata as unknown as Record<string, unknown> | null;
  for (const [key, intended] of Object.entries(requested.metadata ?? {})) {
    if (key === "id" || key === "timeBlockLinkId" || same(oldMetadata?.[key], intended)) continue;
    const actual = newMetadata?.[key];
    const sameTime =
      (key === "scheduledStart" || key === "scheduledEnd") &&
      typeof actual === "string" &&
      typeof intended === "string" &&
      Number.isFinite(Date.parse(actual)) &&
      Date.parse(actual) === Date.parse(intended);
    if (!same(actual, intended) && !sameTime) return null;
    intendedMetadata.add(key);
  }
  if (inverse.metadata) {
    inverse.metadata = Object.fromEntries(
      Object.entries(inverse.metadata).filter(([key]) => intendedMetadata.has(key)),
    );
    if (!Object.keys(inverse.metadata).length) delete inverse.metadata;
  }
  return inverse;
}
function itemInverse(before: ExternalItem, after: ExternalItem): ItemPatch {
  const patch: ItemPatch = {};
  for (const key of ["title", "start", "end", "allDay", "completed"] as const) {
    if (!same(before[key], after[key])) Object.assign(patch, { [key]: before[key] });
  }
  for (const key of ["timeZone", "location", "description", "dueDate"] as const) {
    if (!same(before[key], after[key])) Object.assign(patch, { [key]: before[key] ?? null });
  }
  return patch;
}
function schedule(link?: TimeBlockLink): Partial<TaskMetadata> {
  return {
    scheduledStart: link?.start,
    scheduledEnd: link?.end,
    timeZone: link?.timeZone,
  };
}

/** Session-only history; every reverse edit uses the same guarded write path. */
export class PlannerUndoController {
  private records: UndoRecord[] = [];
  private generation = 0;
  readonly entry: Accessor<PlannerUndoEntry | null>;
  readonly busy: Accessor<boolean>;
  private readonly setEntry: Setter<PlannerUndoEntry | null>;
  private readonly setBusy: Setter<boolean>;

  private readonly host: UndoHost;
  private readonly readItem: (ref: EventRef) => Promise<ExternalItem | null>;
  constructor(
    host: UndoHost,
    readItem: (ref: EventRef) => Promise<ExternalItem | null> = providers.get,
  ) {
    this.host = host;
    this.readItem = readItem;
    [this.entry, this.setEntry] = createSignal<PlannerUndoEntry | null>(null);
    [this.busy, this.setBusy] = createSignal(false);
  }

  clear() {
    this.generation++;
    this.records = [];
    this.setEntry(null);
  }
  private showEntry() {
    const entry = this.records.at(-1);
    this.setEntry(
      entry ? { id: entry.id, label: entry.label, recreatesBlock: entry.recreatesBlock } : null,
    );
  }
  private pending(task: PlannerTask | ExternalItem, link?: TimeBlockLink) {
    return this.host.state.operations.some((operation) => {
      if (link && operation.linkId === link.id) return true;
      if ("path" in task) {
        return operation.task?.kind === "note" && operation.task.taskId === task.metadata?.id;
      }
      return (
        !!task.writeRef &&
        ((!!operation.eventRef && sameEventRef(operation.eventRef, task.writeRef)) ||
          (operation.task?.kind === "reminder" &&
            sameEventRef(operation.task.eventRef, task.writeRef)))
      );
    });
  }
  private taskSnapshot(task: PlannerTask): TaskSnapshot {
    return copy({
      task,
      link: this.host.timeBlockForTask(task),
      calendar: this.host.state.preferences.defaultCalendar ?? null,
    });
  }
  private reminderSnapshot(item: ExternalItem): ReminderSnapshot {
    return copy({
      item,
      link: this.host.timeBlockForTask(item),
      calendar: this.host.state.preferences.defaultCalendar ?? null,
    });
  }
  private currentTask(expected: PlannerTask): PlannerTask {
    if (!expected.metadata?.id) throw new PlannerUndoError("unavailable");
    const matches = this.host.state.tasks.filter(
      (task) => task.metadata?.id === expected.metadata?.id,
    );
    if (matches.length !== 1) throw new PlannerUndoError("unavailable");
    const current = matches[0];
    if (!same(taskValue(current), taskValue(expected))) throw new PlannerUndoError("changed");
    return current;
  }
  private checkLink(task: PlannerTask | ExternalItem, expected?: TimeBlockLink) {
    const current = this.host.timeBlockForTask(task);
    if (this.pending(task, current ?? expected)) throw new PlannerUndoError("pending");
    if (!same(linkValue(current), linkValue(expected))) throw new PlannerUndoError("changed");
    if (current && current.status !== "synced") throw new PlannerUndoError("changed");
  }
  private checkCalendar(
    before: { link?: TimeBlockLink },
    after: { link?: TimeBlockLink; calendar: CalendarChoice | null },
  ) {
    if (after.link) return;
    const expected = before.link
      ? { provider: before.link.eventRef.provider, calendarId: before.link.eventRef.calendarId }
      : after.calendar;
    if (!same(this.host.state.preferences.defaultCalendar ?? null, expected))
      throw new PlannerUndoError("calendar");
  }
  private async currentItem(expected: ExternalItem, assertCurrent: () => void) {
    const ref = expected.writeRef;
    if (!ref) throw new PlannerUndoError("unavailable");
    const source = this.host.state.sources[ref.provider];
    if (!source.status.connected || !this.host.state.preferences.enabledSources[ref.provider])
      throw new PlannerUndoError("unavailable");
    const current = await this.readItem(ref);
    assertCurrent();
    if (!current?.writeRef || !sameEventRef(current.writeRef, ref))
      throw new PlannerUndoError("unavailable");
    if (!same(itemValue(current), itemValue(expected))) throw new PlannerUndoError("changed");
    // Use the freshly read version for the service's conditional write. A new
    // version with identical content (including an earlier undo) is harmless.
    return current;
  }
  private async verifyRemoteBlock(expected: TimeBlockLink | undefined, assertCurrent: () => void) {
    if (!expected) return;
    const source = this.host.state.sources[expected.eventRef.provider];
    if (
      !source.status.connected ||
      !this.host.state.preferences.enabledSources[expected.eventRef.provider]
    )
      throw new PlannerUndoError("unavailable");
    const current = await this.readItem(expected.eventRef);
    assertCurrent();
    if (
      !current?.writeRef ||
      !sameEventRef(current.writeRef, expected.eventRef) ||
      current.title !== expected.title ||
      current.start !== expected.start ||
      current.end !== expected.end ||
      current.allDay
    )
      throw new PlannerUndoError("changed");
  }
  private async verifyRemovedBlock(expected: TimeBlockLink | undefined, assertCurrent: () => void) {
    if (!expected) return;
    const source = this.host.state.sources[expected.eventRef.provider];
    if (
      !source.status.connected ||
      !this.host.state.preferences.enabledSources[expected.eventRef.provider]
    )
      throw new PlannerUndoError("unavailable");
    const current = await this.readItem(expected.eventRef);
    assertCurrent();
    // The provider may have restored a deleted event since the user removed it.
    // Recreating another block in that case would duplicate the same work.
    if (current) throw new PlannerUndoError("changed");
  }
  private async perform<T>(
    action: (
      record: (label: string, recreates: boolean, revert: UndoRecord["revert"]) => void,
    ) => Promise<T>,
  ): Promise<T> {
    if (this.busy()) throw new PlannerUndoError("busy");
    const generation = this.generation;
    this.setBusy(true);
    const pendingIds = new Set(this.host.state.operations.map((operation) => operation.id));
    let next: UndoRecord | undefined;
    try {
      const result = await action((label, recreatesBlock, revert) => {
        next = { id: crypto.randomUUID(), label, recreatesBlock, revert };
      });
      if (
        generation === this.generation &&
        next &&
        !this.host.state.operations.some((operation) => !pendingIds.has(operation.id))
      ) {
        this.records.push(next);
        this.records = this.records.slice(-20);
        this.showEntry();
      }
      return result;
    } finally {
      this.setBusy(false);
    }
  }

  updateTask(task: PlannerTask, patch: TaskPatch, label: string) {
    return this.perform(async (record) => {
      const before = this.taskSnapshot(task);
      const result = await this.host.updateTask(task, patch, before.task);
      const after = this.taskSnapshot(result);
      const inverse = requestedTaskInverse(before.task, after.task, patch);
      if (!inverse || !Object.keys(inverse).length || this.pending(result, after.link))
        return result;
      record(label, !!before.link && !after.link, async (assertCurrent) => {
        let current = this.currentTask(after.task);
        this.checkLink(current, after.link);
        if (
          inverse.metadata &&
          (Object.hasOwn(inverse.metadata, "scheduledStart") ||
            Object.hasOwn(inverse.metadata, "scheduledEnd")) &&
          before.task.metadata?.scheduledStart &&
          before.task.metadata?.scheduledEnd
        )
          this.checkCalendar(before, after);
        if (inverse.title !== undefined || inverse.metadata) {
          await this.verifyRemoteBlock(after.link, assertCurrent);
          if (!after.link) await this.verifyRemovedBlock(before.link, assertCurrent);
        }
        assertCurrent();
        current = this.currentTask(after.task);
        this.checkLink(current, after.link);
        await this.host.updateTask(current, inverse, after.task);
      });
      return result;
    });
  }

  updateItem(item: ExternalItem, patch: ItemPatch, label: string) {
    return this.perform(async (record) => {
      const before = copy(item);
      const result = await this.host.updateItem(item, patch);
      const after = copy(result);
      const linked = this.host.linkedTask(result);
      const linkedTask = linked && "path" in linked ? this.taskSnapshot(linked) : undefined;
      const linkedReminder =
        linked && !("path" in linked) ? this.reminderSnapshot(linked) : undefined;
      const inverse = itemInverse(before, after);
      if (
        !Object.keys(inverse).length ||
        !before.writeRef ||
        !after.writeRef ||
        !sameEventRef(before.writeRef, after.writeRef) ||
        this.pending(result, this.host.timeBlockForTask(result))
      )
        return result;
      // EventKit may advance a recurring reminder to its next due occurrence.
      // That new occurrence must not be treated as the completed occurrence.
      if (
        item.kind === "reminder" &&
        patch.completed !== undefined &&
        patch.dueDate === undefined &&
        before.dueDate !== after.dueDate
      )
        return result;
      record(label, false, async (assertCurrent) => {
        const current = await this.currentItem(after, assertCurrent);
        if (this.pending(current, this.host.timeBlockForTask(current)))
          throw new PlannerUndoError("pending");
        if (linkedTask) this.checkLink(this.currentTask(linkedTask.task), linkedTask.link);
        if (linkedReminder) {
          const reminder = await this.currentItem(linkedReminder.item, assertCurrent);
          this.checkLink(reminder, linkedReminder.link);
        }
        assertCurrent();
        await this.host.updateItem(current, inverse);
      });
      return result;
    });
  }

  /** Save the reminder form as one undo step, including its optional calendar block. */
  updateReminder(
    item: ExternalItem,
    patch: ItemPatch,
    metadata: Partial<TaskMetadata> | undefined,
    label: string,
  ) {
    return this.perform(async (record) => {
      const before = this.reminderSnapshot(item);
      const result = await this.host.updateItem(item, patch);
      if (metadata) await this.host.scheduleReminder(result, metadata);
      else if (before.link && patch.title !== undefined)
        await this.host.scheduleReminder(result, schedule(before.link));
      const after = this.reminderSnapshot(result);
      const inverse = itemInverse(before.item, after.item);
      const blockChanged = !same(linkValue(before.link), linkValue(after.link));
      if (
        (!Object.keys(inverse).length && !blockChanged) ||
        this.pending(result, after.link) ||
        !before.item.writeRef ||
        !after.item.writeRef ||
        !sameEventRef(before.item.writeRef, after.item.writeRef)
      )
        return result;
      if (
        patch.completed !== undefined &&
        patch.dueDate === undefined &&
        before.item.dueDate !== after.item.dueDate
      )
        return result;
      record(label, !!before.link && !after.link, async (assertCurrent) => {
        let current = await this.currentItem(after.item, assertCurrent);
        this.checkLink(current, after.link);
        if (blockChanged) this.checkCalendar(before, after);
        await this.verifyRemoteBlock(after.link, assertCurrent);
        if (!after.link) await this.verifyRemovedBlock(before.link, assertCurrent);
        assertCurrent();
        this.checkLink(current, after.link);
        if (Object.keys(inverse).length) current = await this.host.updateItem(current, inverse);
        assertCurrent();
        if (blockChanged || (before.link && inverse.title !== undefined))
          await this.host.scheduleReminder(current, schedule(before.link));
      });
      return result;
    });
  }

  scheduleReminder(item: ExternalItem, metadata: Partial<TaskMetadata>, label: string) {
    return this.perform(async (record) => {
      const before = this.reminderSnapshot(item);
      const result = await this.host.scheduleReminder(item, metadata);
      const after = this.reminderSnapshot(item);
      if (same(linkValue(before.link), linkValue(after.link)) || this.pending(item, after.link))
        return result;
      record(label, !!before.link && !after.link, async (assertCurrent) => {
        const current = await this.currentItem(after.item, assertCurrent);
        this.checkLink(current, after.link);
        this.checkCalendar(before, after);
        await this.verifyRemoteBlock(after.link, assertCurrent);
        if (!after.link) await this.verifyRemovedBlock(before.link, assertCurrent);
        assertCurrent();
        this.checkLink(current, after.link);
        await this.host.scheduleReminder(current, schedule(before.link));
      });
      return result;
    });
  }

  /** Call only for a linked calendar block; deleting a task is intentionally not undoable here. */
  deleteBlock(item: ExternalItem, label: string) {
    return this.perform(async (record) => {
      const linked = this.host.linkedTask(item);
      if (!linked || item.kind !== "event") throw new PlannerUndoError("unavailable");
      const before = "path" in linked ? this.taskSnapshot(linked) : this.reminderSnapshot(linked);
      const result = await this.host.deleteItem(item);
      if ("task" in before) {
        const matches = this.host.state.tasks.filter(
          (task) => task.metadata?.id === before.task.metadata?.id,
        );
        if (matches.length !== 1) return result;
        const after = this.taskSnapshot(matches[0]);
        if (after.link || this.pending(after.task, before.link)) return result;
        record(label, true, async (assertCurrent) => {
          const current = this.currentTask(after.task);
          this.checkLink(current, after.link);
          this.checkCalendar(before, after);
          await this.verifyRemovedBlock(before.link, assertCurrent);
          assertCurrent();
          await this.host.updateTask(current, taskInverse(before.task, after.task), after.task);
        });
      } else {
        const after = this.reminderSnapshot(before.item);
        if (after.link || this.pending(after.item, before.link)) return result;
        record(label, true, async (assertCurrent) => {
          const current = await this.currentItem(after.item, assertCurrent);
          this.checkLink(current, after.link);
          this.checkCalendar(before, after);
          await this.verifyRemovedBlock(before.link, assertCurrent);
          assertCurrent();
          await this.host.scheduleReminder(current, schedule(before.link));
        });
      }
      return result;
    });
  }

  async undo(): Promise<boolean> {
    if (this.busy()) throw new PlannerUndoError("busy");
    const record = this.records.at(-1);
    if (!record) return false;
    const generation = this.generation;
    const assertCurrent = () => {
      if (generation !== this.generation) throw new PlannerUndoError("unavailable");
    };
    this.setBusy(true);
    try {
      await record.revert(assertCurrent);
      assertCurrent();
      // Recreated blocks have new binding/provider identities. Earlier entries
      // still refer to the removed block, so do not offer unsafe stale history.
      if (record.recreatesBlock) this.records = [];
      else this.records.pop();
      this.showEntry();
      return true;
    } finally {
      this.setBusy(false);
    }
  }
}
