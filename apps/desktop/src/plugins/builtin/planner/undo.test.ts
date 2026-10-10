import { describe, expect, it, vi } from "vitest";

import type { PlannerTask, TaskPatch } from "~/lib/planner_tasks";

import { PlannerUndoController, type PlannerUndoError } from "./undo";
import {
  DEFAULT_PREFERENCES,
  sameEventRef,
  type ExternalItem,
  type ItemPatch,
  type PendingOperation,
  type Provider,
  type SourceState,
  type TimeBlockLink,
} from "./types";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const start = "2026-09-04T09:00:00+09:00";
const end = "2026-09-04T09:30:00+09:00";
function note(metadata: PlannerTask["metadata"] = null): PlannerTask {
  return {
    id: metadata?.id ?? "transient:note",
    path: "Tasks/Inbox.md",
    title: "Draft",
    checked: false,
    metadata,
    sourceStart: 0,
    sourceEnd: 16,
  };
}
function external(provider: Provider = "google"): ExternalItem {
  return {
    id: "event",
    provider,
    calendarId: "main",
    title: "Draft",
    kind: provider === "apple-reminders" ? "reminder" : "event",
    allDay: provider === "apple-reminders",
    start: provider === "apple-reminders" ? undefined : start,
    end: provider === "apple-reminders" ? undefined : end,
    completed: provider === "apple-reminders" ? false : undefined,
    writable: true,
    writeRef: { provider, calendarId: "main", itemId: "event", version: "v1" },
  };
}
function fixture(initialTask = note(), initialItem = external()) {
  const state = {
    tasks: [clone(initialTask)],
    timeBlockLinks: [] as TimeBlockLink[],
    operations: [] as PendingOperation[],
    preferences: clone(DEFAULT_PREFERENCES),
    sources: Object.fromEntries(
      (["google", "apple-calendar", "apple-reminders"] as Provider[]).map((provider) => [
        provider,
        {
          status: { provider, connected: true, configured: true, writable: true },
          calendars: [{ id: "main", provider, title: "Main", writable: true }],
          items: [],
          loading: false,
        },
      ]),
    ) as unknown as Record<Provider, SourceState>,
  };
  state.preferences.enabledSources = {
    google: true,
    "apple-calendar": true,
    "apple-reminders": true,
  };
  state.sources[initialItem.provider].items = [clone(initialItem)];
  const remote = new Map([[initialItem.id, clone(initialItem)]]);
  let counter = 1;
  const host = {
    state,
    updateTask: vi.fn(async (task: PlannerTask, patch: TaskPatch, expected?: PlannerTask) => {
      const current = state.tasks.find((value) => value.id === task.id)!;
      if (
        expected &&
        (current.checked !== expected.checked ||
          current.title !== expected.title ||
          JSON.stringify(current.metadata) !== JSON.stringify(expected.metadata))
      )
        throw new Error("CONFLICT: Task changed inside document mutation");
      const next = clone({
        ...current,
        ...patch,
        id: current.metadata?.id ?? "stable-id",
        metadata: {
          ...current.metadata,
          ...patch.metadata,
          id: current.metadata?.id ?? "stable-id",
        },
      });
      state.tasks = state.tasks.map((value) => (value === current ? next : value));
      return next;
    }),
    updateItem: vi.fn(async (item: ExternalItem, patch: ItemPatch) => {
      const current = remote.get(item.id)!;
      if (current.writeRef?.version !== item.writeRef?.version) throw new Error("CONFLICT: ETag");
      const result = clone({
        ...current,
        ...patch,
        writeRef: { ...current.writeRef!, version: `v${++counter}` },
      }) as ExternalItem;
      for (const field of ["timeZone", "location", "description", "dueDate"] as const)
        if (result[field] === null) delete result[field];
      remote.set(result.id, result);
      state.sources[result.provider].items = [result];
      return result;
    }),
    scheduleReminder: vi.fn(
      async (
        item: ExternalItem,
        metadata: { scheduledStart?: string; scheduledEnd?: string; timeZone?: string },
      ) => {
        const old = host.timeBlockForTask(item);
        if (old) {
          state.timeBlockLinks = state.timeBlockLinks.filter((link) => link.id !== old.id);
          remote.delete(old.eventRef.itemId);
        }
        if (metadata.scheduledStart && metadata.scheduledEnd) {
          const id = old?.id ?? `block-${++counter}`;
          const block = {
            ...external(),
            title: item.title,
            id,
            start: metadata.scheduledStart,
            end: metadata.scheduledEnd,
            writeRef: { ...external().writeRef!, itemId: id },
          };
          remote.set(id, block);
          state.timeBlockLinks.push({
            id,
            task: { kind: "reminder", eventRef: item.writeRef! },
            eventRef: block.writeRef!,
            title: item.title,
            start: block.start,
            end: block.end,
            timeZone: metadata.timeZone,
            status: "synced",
            lastSync: {
              title: item.title,
              start: block.start,
              end: block.end,
              taskTitle: item.title,
            },
          });
        }
      },
    ),
    deleteItem: vi.fn(async (item: ExternalItem) => {
      remote.delete(item.id);
      state.timeBlockLinks = state.timeBlockLinks.filter(
        (link) => !sameEventRef(link.eventRef, item.writeRef!),
      );
    }),
    timeBlockForTask: (task: PlannerTask | ExternalItem) =>
      state.timeBlockLinks.find((link) =>
        "path" in task
          ? link.task.kind === "note" && link.task.taskId === task.metadata?.id
          : link.task.kind === "reminder" &&
            !!task.writeRef &&
            sameEventRef(link.task.eventRef, task.writeRef),
      ),
    linkedTask: (item: ExternalItem): PlannerTask | ExternalItem | null => {
      const link = state.timeBlockLinks.find(
        (candidate) => item.writeRef && sameEventRef(candidate.eventRef, item.writeRef),
      );
      if (!link) return null;
      const task = link.task;
      return task.kind === "note"
        ? (state.tasks.find((candidate) => candidate.metadata?.id === task.taskId) ?? null)
        : (state.sources[task.eventRef.provider].items.find(
            (candidate) => candidate.writeRef && sameEventRef(candidate.writeRef, task.eventRef),
          ) ?? null);
    },
  };
  const read = vi.fn(async (ref: { itemId: string }) => clone(remote.get(ref.itemId) ?? null));
  return { host, state, remote, read, undo: new PlannerUndoController(host, read) };
}

async function expectUndoError(action: Promise<unknown>, code: PlannerUndoError["code"]) {
  await expect(action).rejects.toMatchObject({ name: "PlannerUndoError", code });
}

describe("Planner session undo", () => {
  it("restores completion after the first edit without removing its stable identity", async () => {
    const { host, state, undo } = fixture();
    const saved = await undo.updateTask(state.tasks[0], { checked: true }, "Completed");
    expect(saved.metadata?.id).toBe("stable-id");
    expect(undo.entry()?.label).toBe("Completed");
    await undo.undo();
    expect(state.tasks[0]).toMatchObject({ checked: false, metadata: { id: "stable-id" } });
    expect(host.updateTask.mock.calls[1][2]).toEqual(saved);
    expect(undo.entry()).toBeNull();
  });

  it("follows a stable task across note renames, but rejects copies and changed content", async () => {
    const { state, undo, host } = fixture(note({ id: "task" }));
    await undo.updateTask(state.tasks[0], { checked: true }, "Completed");
    state.tasks[0].path = "Moved.md";
    state.tasks.push(clone(state.tasks[0]));
    await expectUndoError(undo.undo(), "unavailable");
    state.tasks.pop();
    state.tasks[0].title = "Edited elsewhere";
    await expectUndoError(undo.undo(), "changed");
    state.tasks[0].title = "Draft";
    await undo.undo();
    expect(host.updateTask.mock.calls.at(-1)?.[0].path).toBe("Moved.md");
  });

  it("undoes local scheduling while preserving deadlines and newly assigned IDs", async () => {
    const { state, undo } = fixture(note({ id: "task", dueDate: "2026-09-10" }));
    await undo.updateTask(
      state.tasks[0],
      {
        metadata: {
          scheduledStart: start,
          scheduledEnd: end,
          plannedDate: "2026-09-04",
          timeZone: "Asia/Seoul",
        },
      },
      "Scheduled",
    );
    await undo.undo();
    expect(state.tasks[0].metadata).toEqual({ id: "task", dueDate: "2026-09-10" });
  });

  it("preserves unrelated edits that arrive between a write and its rescan", async () => {
    const { state, undo, host } = fixture(note({ id: "task", dueDate: "2026-09-10" }));
    const original = host.updateTask.getMockImplementation()!;
    host.updateTask.mockImplementationOnce(async (...args) => {
      const saved = await original(...args);
      saved.title = "Edited in the note while saving";
      saved.metadata.dueDate = "2026-09-12";
      return saved;
    });
    await undo.updateTask(
      state.tasks[0],
      { checked: true, metadata: { dueDate: "2026-09-10" } },
      "Completed",
    );
    await undo.undo();
    expect(state.tasks[0]).toMatchObject({
      title: "Edited in the note while saving",
      checked: false,
      metadata: { dueDate: "2026-09-12" },
    });
    expect(host.updateTask.mock.calls[1][1]).toEqual({ checked: false });
  });

  it("does not record a stale inverse when the field just edited changed again before rescan", async () => {
    const { state, undo, host } = fixture(note({ id: "task" }));
    const original = host.updateTask.getMockImplementation()!;
    host.updateTask.mockImplementationOnce(async (...args) => {
      const saved = await original(...args);
      saved.title = "A newer external title";
      return saved;
    });
    await undo.updateTask(state.tasks[0], { title: "Planner title" }, "Renamed");
    expect(undo.entry()).toBeNull();
    expect(state.tasks[0].title).toBe("A newer external title");
  });

  it("supports consecutive completion undos without stale task snapshots", async () => {
    const { state, undo } = fixture(note({ id: "task" }));
    await undo.updateTask(state.tasks[0], { checked: true }, "Completed");
    await undo.updateTask(state.tasks[0], { checked: false }, "Reopened");
    await undo.undo();
    expect(state.tasks[0].checked).toBe(true);
    await undo.undo();
    expect(state.tasks[0].checked).toBe(false);
  });

  it("reads the remote item before undo and keeps changed remote content intact", async () => {
    const { state, undo, remote, host } = fixture();
    await undo.updateItem(
      state.sources.google.items[0],
      { start: "2026-09-04T10:00:00+09:00", end: "2026-09-04T10:30:00+09:00" },
      "Moved",
    );
    remote.get("event")!.description = "External edit";
    await expectUndoError(undo.undo(), "changed");
    expect(host.updateItem).toHaveBeenCalledTimes(1);
    expect(remote.get("event")!.start).toContain("10:00");
    expect(undo.entry()).not.toBeNull();
  });

  it("uses the fresh ETag when undoing a chain of external moves", async () => {
    const { state, undo, remote, host } = fixture();
    await undo.updateItem(state.sources.google.items[0], { title: "First" }, "First edit");
    await undo.updateItem(state.sources.google.items[0], { title: "Second" }, "Second edit");
    await undo.undo();
    await undo.undo();
    expect(remote.get("event")!.title).toBe("Draft");
    expect(host.updateItem.mock.calls.at(-1)?.[0].writeRef?.version).toBe("v4");
  });

  it("does not record failed or partially journaled writes", async () => {
    const { state, undo, host } = fixture();
    host.updateTask.mockRejectedValueOnce(new Error("Write failed"));
    await expect(undo.updateTask(state.tasks[0], { checked: true }, "Complete")).rejects.toThrow(
      "Write failed",
    );
    expect(undo.entry()).toBeNull();
    const original = host.updateTask.getMockImplementation()!;
    host.updateTask.mockImplementationOnce(async (...args) => {
      const task = await original(...args);
      state.operations.push({
        id: "pending",
        type: "update",
        provider: "google",
        calendarId: "main",
        status: "failed",
        attempts: 1,
        createdAt: "now",
        stage: "local",
        task: { kind: "note", taskId: task.metadata!.id, path: task.path },
      });
      return task;
    });
    await undo.updateTask(state.tasks[0], { checked: true }, "Complete");
    expect(undo.entry()).toBeNull();
  });

  it("restores an unscheduled reminder as a new block and retires obsolete binding history", async () => {
    const reminder = external("apple-reminders");
    reminder.completed = true;
    const { state, undo, remote } = fixture(note(), reminder);
    state.preferences.defaultCalendar = { provider: "google", calendarId: "main" };
    await undo.scheduleReminder(
      reminder,
      { scheduledStart: start, scheduledEnd: end },
      "Scheduled",
    );
    const old = state.timeBlockLinks[0];
    await undo.deleteBlock(remote.get(old.eventRef.itemId)!, "Unscheduled");
    expect(state.timeBlockLinks).toHaveLength(0);
    expect(undo.entry()?.recreatesBlock).toBe(true);
    await undo.undo();
    expect(state.timeBlockLinks[0].start).toBe(start);
    expect(state.timeBlockLinks[0].eventRef.itemId).not.toBe(old.eventRef.itemId);
    expect(remote.get("event")?.completed).toBe(true);
    expect(undo.entry()).toBeNull();
    expect(await undo.undo()).toBe(false);
  });

  it("undoes reminder form content and scheduling together in one step", async () => {
    const reminder = external("apple-reminders");
    const { state, undo, host, remote } = fixture(note(), reminder);
    state.preferences.defaultCalendar = { provider: "google", calendarId: "main" };
    await host.scheduleReminder(reminder, { scheduledStart: start, scheduledEnd: end });
    await undo.updateReminder(
      reminder,
      { title: "Renamed", completed: true },
      {
        scheduledStart: "2026-09-04T10:00:00+09:00",
        scheduledEnd: "2026-09-04T10:45:00+09:00",
      },
      "Updated reminder",
    );
    expect(remote.get("event")).toMatchObject({ title: "Renamed", completed: true });
    expect(state.timeBlockLinks[0].start).toContain("10:00");
    await undo.undo();
    expect(remote.get("event")).toMatchObject({ title: "Draft", completed: false });
    expect(state.timeBlockLinks[0]).toMatchObject({ title: "Draft", start, end });
    expect(undo.entry()).toBeNull();
  });

  it("keeps partial reminder form failures out of undo history", async () => {
    const reminder = external("apple-reminders");
    const { undo, host, remote } = fixture(note(), reminder);
    host.scheduleReminder.mockRejectedValueOnce(new Error("Calendar write failed"));
    await expect(
      undo.updateReminder(
        reminder,
        { title: "Renamed" },
        { scheduledStart: start, scheduledEnd: end },
        "Updated reminder",
      ),
    ).rejects.toThrow("Calendar write failed");
    expect(remote.get("event")?.title).toBe("Renamed");
    expect(undo.entry()).toBeNull();
  });

  it("does not duplicate a deleted block that was restored by the provider", async () => {
    const reminder = external("apple-reminders");
    const { state, undo, host, remote } = fixture(note(), reminder);
    state.preferences.defaultCalendar = { provider: "google", calendarId: "main" };
    await host.scheduleReminder(reminder, { scheduledStart: start, scheduledEnd: end });
    const previous = clone(remote.get(state.timeBlockLinks[0].eventRef.itemId)!);
    await undo.scheduleReminder(reminder, {}, "Unscheduled");
    remote.set(previous.id, previous);
    await expectUndoError(undo.undo(), "changed");
    expect(host.scheduleReminder).toHaveBeenCalledTimes(2);
    expect(remote.size).toBe(2);
  });

  it("does not restore a removed block into a different default calendar", async () => {
    const reminder = external("apple-reminders");
    const { state, undo, host } = fixture(note(), reminder);
    state.preferences.defaultCalendar = { provider: "google", calendarId: "main" };
    await host.scheduleReminder(reminder, { scheduledStart: start, scheduledEnd: end });
    await undo.scheduleReminder(reminder, {}, "Unscheduled");
    state.preferences.defaultCalendar = { provider: "apple-calendar", calendarId: "other" };
    await expectUndoError(undo.undo(), "calendar");
    expect(host.scheduleReminder).toHaveBeenCalledTimes(2);
  });

  it("does not undo completion onto the next recurring reminder occurrence", async () => {
    const reminder = { ...external("apple-reminders"), dueDate: "2026-09-04" };
    const { undo, host } = fixture(note(), reminder);
    host.updateItem.mockResolvedValueOnce({ ...reminder, dueDate: "2026-09-05", completed: false });
    await undo.updateItem(reminder, { completed: true }, "Completed");
    expect(undo.entry()).toBeNull();
  });

  it("cancels a pending undo read when history is cleared for a vault change", async () => {
    const { state, undo, read, host } = fixture();
    await undo.updateItem(state.sources.google.items[0], { title: "Changed" }, "Edited");
    let resolve!: (item: ExternalItem) => void;
    read.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const pending = undo.undo();
    undo.clear();
    resolve(state.sources.google.items[0]);
    await expectUndoError(pending, "unavailable");
    expect(host.updateItem).toHaveBeenCalledTimes(1);
    expect(undo.entry()).toBeNull();
  });
});
