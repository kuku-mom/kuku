import { describe, expect, it, vi } from "vitest";

import type { PlannerTask, TaskPatch } from "~/lib/planner_tasks";
import { createProxyToolRegistry } from "~/plugins/builtin/core_tool_registry/registry";
import type { PluginContext } from "~/plugins/types";

import { PLANNER_AI_TOOL_NAMES, registerPlannerAiTools } from "./ai_tools";
import type { PlannerService } from "./service";
import {
  DEFAULT_PREFERENCES,
  eventRefKey,
  type EventRef,
  type ExternalItem,
  type ItemDraft,
  type ItemPatch,
  type PendingOperation,
  type Provider,
  type SourceState,
  type TimeBlockLink,
} from "./types";

vi.mock("~/i18n", () => ({ currentLocale: () => "en" }));
vi.mock("~/stores/vault", () => ({ vaultState: { rootPath: "/vault" } }));
vi.mock("~/plugins/document_mutations", () => ({ focusTask: vi.fn() }));

const day = "2026-09-05";
const at = (hour: number) => new Date(2026, 8, 5, hour).toISOString();
function task(id = "task-1", name = "Review notes"): PlannerTask {
  return {
    id,
    title: name,
    checked: false,
    path: "Tasks/Inbox.md",
    metadata: { id },
    sourceStart: 0,
    sourceEnd: 60,
    sourceChecksum: "checksum-1",
  };
}
function event(id = "event-1", provider: Provider = "google"): ExternalItem {
  return {
    id: `display-${id}`,
    provider,
    calendarId: provider === "apple-reminders" ? "list" : "work",
    title: id,
    kind: provider === "apple-reminders" ? "reminder" : "event",
    allDay: false,
    start: at(10),
    end: at(11),
    completed: false,
    writable: true,
    writeRef: {
      provider,
      calendarId: provider === "apple-reminders" ? "list" : "work",
      itemId: id,
      version: "v1",
    },
  };
}
function memoryStore() {
  const files = new Map<string, string>();
  return {
    files,
    fs: {
      exists: vi.fn(async (path: string) => files.has(path)),
      readFile: vi.fn(async (path: string) => files.get(path)!),
      writeFile: vi.fn(async (path: string, content: string) => {
        files.set(path, content);
      }),
    } as unknown as PluginContext["fs"],
  };
}
function fixture(store?: PluginContext["fs"]) {
  const source = (provider: Provider): SourceState => ({
    status: { provider, connected: true, configured: true, writable: true },
    calendars: [
      {
        provider,
        id: provider === "apple-reminders" ? "list" : "work",
        title: provider === "apple-reminders" ? "Personal reminders" : "Work",
        writable: true,
        accountId: "do-not-expose-account",
      },
    ],
    items: [],
    loading: false,
  });
  const state = {
    tasks: [task()],
    notes: ["Tasks/Inbox.md", "Notes/Meeting.md"],
    sources: {
      google: source("google"),
      "apple-calendar": source("apple-calendar"),
      "apple-reminders": source("apple-reminders"),
    },
    preferences: structuredClone(DEFAULT_PREFERENCES),
    operations: [] as PendingOperation[],
    timeBlockLinks: [] as TimeBlockLink[],
  };
  const remote = new Map<string, ExternalItem>();
  const saveRemote = (item: ExternalItem) => {
    remote.set(eventRefKey(item.writeRef!), structuredClone(item));
    return item;
  };
  let root: string | null = "/vault-a";
  const service = {
    state,
    scan: vi.fn(async () => {}),
    setAnchor: vi.fn(),
    refresh: vi.fn(),
    selectCalendar: vi.fn(),
    visibleCalendars: (provider: Provider) => state.sources[provider].calendars,
    timeBlockForTask: (item: PlannerTask | ExternalItem) =>
      state.timeBlockLinks.find((link) =>
        "path" in item
          ? link.task.kind === "note" && link.task.taskId === item.metadata?.id
          : link.task.kind === "reminder" &&
            !!item.writeRef &&
            eventRefKey(link.task.eventRef) === eventRefKey(item.writeRef),
      ),
    linkedTask: (item: ExternalItem) => {
      const link = state.timeBlockLinks.find(
        (link) => !!item.writeRef && eventRefKey(link.eventRef) === eventRefKey(item.writeRef),
      );
      return link?.task.kind === "note"
        ? state.tasks.find((task) => task.metadata?.id === (link.task as { taskId: string }).taskId)
        : null;
    },
    linkedNotes: vi.fn(() => [] as string[]),
    addTask: vi.fn(async (title: string, options: { metadata?: TaskPatch["metadata"] } = {}) => {
      const created = task(crypto.randomUUID(), title);
      created.metadata = { ...created.metadata!, ...options.metadata };
      state.tasks.push(created);
      return { kind: "note" as const, taskId: created.id, path: created.path };
    }),
    updateTask: vi.fn(
      async (
        item: PlannerTask,
        patch: TaskPatch,
        _expected?: PlannerTask,
      ): Promise<PlannerTask> => {
        const result = {
          ...item,
          ...(patch.title !== undefined ? { title: patch.title } : {}),
          ...(patch.checked !== undefined ? { checked: patch.checked } : {}),
          metadata: { ...item.metadata!, ...patch.metadata },
        };
        state.tasks = state.tasks.map((task) =>
          task.metadata?.id === item.metadata?.id ? result : task,
        );
        return result;
      },
    ),
    deleteTask: vi.fn(async (item: PlannerTask, _deleteBlock: boolean, _expected?: PlannerTask) => {
      state.tasks = state.tasks.filter((task) => task.metadata?.id !== item.metadata?.id);
    }),
    createItem: vi.fn(async (provider: Provider, calendarId: string, draft: ItemDraft) =>
      saveRemote({ ...event(crypto.randomUUID(), provider), ...draft, calendarId }),
    ),
    updateItem: vi.fn(async (item: ExternalItem, patch: ItemPatch) =>
      saveRemote({
        ...item,
        ...patch,
        writeRef: { ...item.writeRef!, version: "v2" },
      } as ExternalItem),
    ),
    deleteItem: vi.fn(async (item: ExternalItem) => {
      remote.delete(eventRefKey(item.writeRef!));
    }),
    scheduleReminder: vi.fn(async () => {}),
    removeReminderBlock: vi.fn(async () => {}),
    attachNote: vi.fn(async () => {}),
    createNote: vi.fn(async () => {
      state.notes.push("Calendar/Event.md");
      return "Calendar/Event.md";
    }),
  };
  const adapter = {
    status: vi.fn(async (provider: Provider) => structuredClone(state.sources[provider].status)),
    calendars: vi.fn(async (provider: Provider) =>
      structuredClone(state.sources[provider].calendars),
    ),
    items: vi.fn(
      async (provider: Provider, ids: string[], _start: string, _end: string, _zone: string) =>
        [...remote.values()]
          .filter((item) => item.provider === provider && ids.includes(item.calendarId))
          .map((item) => structuredClone(item)),
    ),
    get: vi.fn(async (ref: EventRef) => structuredClone(remote.get(eventRefKey(ref)) ?? null)),
  };
  const registry = createProxyToolRegistry();
  const openSource = vi.fn(async () => {});
  let dispose = registerPlannerAiTools(registry, service as unknown as PlannerService, {
    adapter,
    vaultRoot: () => root,
    now: () => new Date(2026, 8, 4, 8),
    requestStore: store,
    openSource,
  });
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    JSON.parse(await registry.getHandler(name)!(args));
  const enable = (provider: Provider) => {
    state.preferences.enabledSources[provider] = true;
    state.preferences.selectedCalendars[provider] = [
      provider === "apple-reminders" ? "list" : "work",
    ];
  };
  return {
    state,
    service,
    adapter,
    registry,
    call,
    openSource,
    saveRemote,
    remote,
    enable,
    setRoot: (value: string) => {
      root = value;
    },
    dispose: () => dispose(),
    restart: () => {
      dispose();
      dispose = registerPlannerAiTools(registry, service as unknown as PlannerService, {
        adapter,
        vaultRoot: () => root,
        now: () => new Date(2026, 8, 4, 8),
        requestStore: store,
        openSource,
      });
    },
  };
}
async function errorCode(promise: Promise<unknown>, code: string) {
  try {
    await promise;
    throw new Error("Expected Planner error");
  } catch (error) {
    const result = JSON.parse((error as Error).message);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe(code);
    return result.error;
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("Planner AI tools", () => {
  it("registers explicit access modes, opaque names, and disposes captured handlers", async () => {
    const f = fixture();
    expect(
      f.registry
        .list()
        .map((tool) => tool.name)
        .sort(),
    ).toEqual([...PLANNER_AI_TOOL_NAMES].sort());
    for (const tool of f.registry.list()) {
      expect(tool.toolId).toBe(`planner.${tool.name.slice(8)}`);
      expect(tool.access).toBe(
        /(?:_list|_search|_read|_availability|_open_source)$/.test(tool.name)
          ? "readOnly"
          : "proposesMutation",
      );
    }
    const captured = f.registry.getHandler("planner_tasks_search")!;
    f.dispose();
    expect(f.registry.list()).toHaveLength(0);
    await errorCode(captured({}), "DISABLED");
  });

  it("grounds searches in all notes and reminder lists, without syncing or moving the week", async () => {
    const f = fixture();
    f.enable("apple-reminders");
    f.state.tasks[0].title = "Ｒｅｖｉｅｗ PLAN";
    f.saveRemote({
      ...event("remote-plan", "apple-reminders"),
      title: "Review plan",
      dueDate: "2027-01-01",
    });
    const result = await f.call("planner_tasks_search", { query: "review PLAN", sort: "due" });
    expect(result.tasks).toHaveLength(2);
    expect(result.tasks[0].provider).toBe("apple-reminders");
    expect(result.incompleteSources).toEqual([]);
    expect(result.currentDate).toBe("2026-09-04");
    expect(result.nowISO).toBeTruthy();
    expect(result.timeZone).toBeTruthy();
    expect(f.service.scan).toHaveBeenCalledWith({ sync: false, throwOnError: true });
    expect(f.service.refresh).not.toHaveBeenCalled();
    expect(f.service.setAnchor).not.toHaveBeenCalled();
    expect(f.service.selectCalendar).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("do-not-expose-account");
    const calendars = await f.call("planner_calendars_list");
    expect(JSON.stringify(calendars)).not.toContain("do-not-expose-account");
  });

  it("marks an explicitly disabled reminder source incomplete and rejects partial vault reads", async () => {
    const f = fixture();
    expect((await f.call("planner_tasks_search", { source: "apple" })).incompleteSources).toEqual([
      "apple-reminders",
    ]);
    f.service.scan.mockRejectedValueOnce(new Error("read failed"));
    await errorCode(f.call("planner_tasks_search"), "DATA_UNAVAILABLE");
  });

  it("rejects unknown fields, invalid dates and missing destructive choices before writing", async () => {
    const f = fixture();
    const item = (await f.call("planner_tasks_search")).tasks[0];
    for (const args of [
      { title: "Task", request_id: "valid-id-1", secret: "ignored?" },
      { title: "Task\n- [ ] injected", request_id: "valid-id-1" },
      { title: "Task", due_date: "2026-02-30", request_id: "valid-id-1" },
    ])
      await errorCode(f.call("planner_task_create", args), "INVALID_ARGUMENT");
    await errorCode(
      f.call("planner_task_update", { ref: item.ref, revision: item.revision, patch: {} }),
      "INVALID_ARGUMENT",
    );
    await errorCode(
      f.call("planner_task_delete", { ref: item.ref, revision: item.revision }),
      "INVALID_ARGUMENT",
    );
    await errorCode(
      f.call("planner_task_schedule", {
        ref: item.ref,
        revision: item.revision,
        start: `${day}T09:00`,
        end: at(10),
        calendar_ref: null,
      }),
      "INVALID_ARGUMENT",
    );
    expect(f.service.addTask).not.toHaveBeenCalled();
    expect(f.service.updateTask).not.toHaveBeenCalled();
    expect(f.service.deleteTask).not.toHaveBeenCalled();
  });

  it("resolves stable task IDs after moves, requires current revisions, and refuses duplicate IDs", async () => {
    const f = fixture();
    let item = (await f.call("planner_tasks_search")).tasks[0];
    f.state.tasks[0] = {
      ...f.state.tasks[0],
      path: "Moved/New.md",
      sourceChecksum: "new-checksum",
    };
    item = (
      await f.call("planner_task_update", {
        ref: item.ref,
        revision: item.revision,
        patch: { title: "Moved task" },
      })
    ).task;
    expect(f.service.updateTask.mock.calls[0][2]?.path).toBe("Moved/New.md");
    f.state.tasks[0] = { ...f.state.tasks[0], title: "Changed externally" };
    const stale = await errorCode(
      f.call("planner_task_complete", { ref: item.ref, revision: item.revision, completed: true }),
      "STALE_REFERENCE",
    );
    expect(stale.current.title).toBe("Changed externally");
    f.state.tasks.push({ ...f.state.tasks[0], path: "Copied.md" });
    await errorCode(f.call("planner_task_read", { ref: item.ref }), "AMBIGUOUS_REFERENCE");
    expect(f.service.updateTask).toHaveBeenCalledTimes(1);
  });

  it("creates once, remints references after restart, and preserves block history through completion", async () => {
    const store = memoryStore();
    const f = fixture(store.fs);
    const args = { title: "Created by AI", request_id: "create-durable-task-001" };
    let item = (await f.call("planner_task_create", args)).task;
    const first = item.ref;
    f.restart();
    const replay = await f.call("planner_task_create", args);
    item = replay.task;
    expect(replay.replayed).toBe(true);
    expect(item.ref).not.toBe(first);
    expect(f.service.addTask).toHaveBeenCalledTimes(1);
    item = (
      await f.call("planner_task_schedule", {
        ref: item.ref,
        revision: item.revision,
        start: at(10),
        end: at(11),
        calendar_ref: null,
      })
    ).task;
    expect(item.start).toBe(at(10));
    const completed = await f.call("planner_task_complete", {
      ref: item.ref,
      revision: item.revision,
      completed: true,
    });
    item = completed.task;
    expect(item.completed).toBe(true);
    expect(item.start).toBe(at(10));
    expect(completed.calendarBlockPreserved).toBe(true);
    item = (await f.call("planner_task_unassign", { ref: item.ref, revision: item.revision })).task;
    expect(item.start).toBeUndefined();
    await f.call("planner_task_delete", {
      ref: item.ref,
      revision: item.revision,
      delete_block: false,
    });
    expect(f.service.deleteTask.mock.calls[0][1]).toBe(false);
    expect(f.service.deleteTask.mock.calls[0][2]?.metadata?.id).toBe(
      f.service.deleteTask.mock.calls[0][0].metadata?.id,
    );
  });

  it("uses fresh external versions and calendar permissions before any event writes", async () => {
    const f = fixture();
    f.enable("google");
    const remote = f.saveRemote(event());
    const item = (await f.call("planner_events_list", { start: at(0), end: at(23) })).events[0];
    f.saveRemote({
      ...remote,
      title: "Remote change",
      writeRef: { ...remote.writeRef!, version: "v2" },
    });
    await errorCode(
      f.call("planner_event_update", {
        ref: item.ref,
        revision: item.revision,
        patch: { title: "Overwrite" },
      }),
      "STALE_REFERENCE",
    );
    const fresh = (await f.call("planner_event_read", { ref: item.ref })).item;
    f.state.sources.google.status.connected = false;
    await errorCode(
      f.call("planner_event_delete", { ref: fresh.ref, revision: fresh.revision }),
      "SOURCE_UNAVAILABLE",
    );
    f.state.sources.google.status.connected = true;
    f.saveRemote({ ...remote, writable: false, writeRef: { ...remote.writeRef!, version: "v2" } });
    await errorCode(
      f.call("planner_event_delete", { ref: fresh.ref, revision: fresh.revision }),
      "READ_ONLY",
    );
    expect(f.service.updateItem).not.toHaveBeenCalled();
    expect(f.service.deleteItem).not.toHaveBeenCalled();
  });

  it("creates Apple reminders without selecting a list, and conditionally edits/deletes real events", async () => {
    const f = fixture();
    f.enable("google");
    f.enable("apple-reminders");
    const calendars = (await f.call("planner_calendars_list")).calendars;
    const reminder = await f.call("planner_task_create", {
      title: "Apple task",
      calendar_ref: calendars.find(
        (entry: { provider: string }) => entry.provider === "apple-reminders",
      ).ref,
      due_date: day,
      request_id: "apple-create-001",
    });
    expect(reminder.item.provider).toBe("apple-reminders");
    expect(f.service.addTask).not.toHaveBeenCalled();
    expect(f.service.selectCalendar).not.toHaveBeenCalled();
    const created = await f.call("planner_event_create", {
      calendar_ref: calendars.find((entry: { provider: string }) => entry.provider === "google")
        .ref,
      event: { title: "Deep work", start: day, end: "2026-09-06", all_day: true },
      request_id: "event-create-001",
    });
    const edited = await f.call("planner_event_update", {
      ref: created.item.ref,
      revision: created.item.revision,
      patch: { title: "Focus", description: "Preparation" },
    });
    expect(f.service.updateItem.mock.calls[0][0].writeRef?.version).toBe("v1");
    await f.call("planner_event_delete", {
      ref: edited.event.ref,
      revision: edited.event.revision,
    });
    expect(f.service.deleteItem.mock.calls[0][0].writeRef?.version).toBe("v2");
  });

  it("reports unresolved provider operations as errors with IDs, never as successful writes", async () => {
    const f = fixture();
    const item = (await f.call("planner_tasks_search")).tasks[0];
    f.service.updateTask.mockImplementationOnce(async (original) => {
      f.state.operations.push({
        id: "pending-op-1",
        type: "create",
        provider: "google",
        calendarId: "work",
        status: "failed",
        stage: "remote",
        attempts: 1,
        createdAt: at(10),
        error: "secret-token-do-not-expose",
      });
      return original;
    });
    const error = await errorCode(
      f.call("planner_task_complete", { ref: item.ref, revision: item.revision, completed: true }),
      "PENDING_OPERATION",
    );
    expect(error.mayHaveApplied).toBe(true);
    expect(error.pendingOperations[0].id).toBe("pending-op-1");
    expect(JSON.stringify(error)).not.toContain("secret-token");
  });

  it("aborts an in-flight read on disposal and a queued creation when its original vault changes", async () => {
    const f = fixture();
    const block = deferred<void>();
    f.service.scan.mockImplementationOnce(() => block.promise);
    const read = f.call("planner_tasks_search");
    f.dispose();
    block.resolve();
    await errorCode(read, "DISABLED");
    const g = fixture();
    const create = deferred<{ kind: "note"; taskId: string; path: string }>();
    g.service.addTask.mockImplementationOnce(() => create.promise);
    const first = g.call("planner_task_create", { title: "A", request_id: "queued-first-001" });
    await vi.waitFor(() => expect(g.service.addTask).toHaveBeenCalledTimes(1));
    const second = g.call("planner_task_create", { title: "B", request_id: "queued-second-001" });
    const firstError = errorCode(first, "DISABLED"),
      secondError = errorCode(second, "DISABLED");
    g.setRoot("/vault-b");
    create.resolve({ kind: "note", taskId: "a", path: "Tasks/Inbox.md" });
    await Promise.all([firstError, secondError]);
    expect(g.service.addTask).toHaveBeenCalledTimes(1);
  });

  it("reads availability for the requested day and unselected default, excludes self, and fails closed", async () => {
    const f = fixture();
    f.enable("google");
    f.state.preferences.selectedCalendars.google = [];
    f.state.preferences.defaultCalendar = { provider: "google", calendarId: "work" };
    f.state.tasks[0].metadata = {
      ...f.state.tasks[0].metadata!,
      scheduledStart: at(10),
      scheduledEnd: at(11),
    };
    const task = (await f.call("planner_tasks_search")).tasks[0];
    f.saveRemote(event());
    const result = await f.call("planner_availability", {
      day,
      duration_minutes: 60,
      preferred_start: at(10),
      exclude_ref: task.ref,
    });
    expect(f.adapter.items).toHaveBeenCalledWith(
      "google",
      ["work"],
      at(0),
      new Date(2026, 8, 6).toISOString(),
      expect.any(String),
    );
    expect(result.overlap.minutes).toBe(60);
    expect(f.state.preferences.selectedCalendars.google).toEqual([]);
    f.adapter.items.mockRejectedValueOnce(new Error("page 2 failed"));
    await errorCode(
      f.call("planner_availability", { day, duration_minutes: 30 }),
      "OPERATION_FAILED",
    );
    f.state.preferences.enabledSources.google = false;
    await errorCode(
      f.call("planner_availability", { day, duration_minutes: 30 }),
      "SOURCE_UNAVAILABLE",
    );
    expect(f.service.setAnchor).not.toHaveBeenCalled();
  });

  it("allows local completion and deadlines while a linked calendar is disconnected", async () => {
    const f = fixture();
    const original = f.state.tasks[0];
    original.metadata = {
      ...original.metadata!,
      scheduledStart: at(10),
      scheduledEnd: at(11),
      timeBlockLinkId: "link-1",
    };
    f.state.timeBlockLinks.push({
      id: "link-1",
      task: { kind: "note", taskId: original.id, path: original.path },
      eventRef: event().writeRef!,
      title: original.title,
      start: at(10),
      end: at(11),
      status: "pending",
      lastSync: {
        title: original.title,
        start: at(10),
        end: at(11),
        taskTitle: original.title,
        taskStart: at(10),
        taskEnd: at(11),
      },
    });
    let item = (await f.call("planner_tasks_search")).tasks[0];
    item = (
      await f.call("planner_task_complete", {
        ref: item.ref,
        revision: item.revision,
        completed: true,
      })
    ).task;
    item = (
      await f.call("planner_task_update", {
        ref: item.ref,
        revision: item.revision,
        patch: { due_date: day },
      })
    ).task;
    expect(item.completed).toBe(true);
    expect(item.dueDate).toBe(day);
    expect(item.start).toBe(at(10));
    expect(f.adapter.get).not.toHaveBeenCalled();
    expect(f.adapter.status).not.toHaveBeenCalled();
    await errorCode(
      f.call("planner_task_update", {
        ref: item.ref,
        revision: item.revision,
        patch: { title: "Must touch remote block" },
      }),
      "PENDING_OPERATION",
    );
    expect(f.service.updateTask).toHaveBeenCalledTimes(2);
  });

  it("links read-only external items only by explicit action and replays created notes safely", async () => {
    const store = memoryStore();
    const f = fixture(store.fs);
    f.enable("google");
    f.saveRemote({ ...event(), writable: false });
    const item = (await f.call("planner_events_list", { start: at(0), end: at(23) })).events[0];
    expect(f.service.createNote).not.toHaveBeenCalled();
    await f.call("planner_link_note", {
      ref: item.ref,
      revision: item.revision,
      mode: "attach",
      path: "Notes/Meeting.md",
    });
    expect(f.service.attachNote).toHaveBeenCalledOnce();
    await f.call("planner_open_source", { ref: item.ref });
    expect(f.openSource).toHaveBeenCalledOnce();
    const args = {
      ref: item.ref,
      revision: item.revision,
      mode: "create",
      request_id: "note-created-001",
    };
    expect((await f.call("planner_link_note", args)).notePath).toBe("Calendar/Event.md");
    expect((await f.call("planner_link_note", args)).replayed).toBe(true);
    expect(f.service.createNote).toHaveBeenCalledOnce();
  });
});
