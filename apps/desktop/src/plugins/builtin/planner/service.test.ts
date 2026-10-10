// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PluginContext } from "~/plugins/types";

import type {
  ConnectionStatus,
  EventRef,
  ExternalCalendar,
  ExternalItem,
  ItemDraft,
  ItemPatch,
  PlannerPreferences,
} from "./types";
import { extractTasks, updateTaskMarkdown } from "~/lib/planner_tasks";

import { linkNote } from "./links";
import { DEFAULT_PREFERENCES } from "./types";
import { BINDINGS_PATH, readTimeBlockLinks } from "./bindings";
import { journalPath } from "./operations";
import { PlannerWriteController } from "./write_controller";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  load: vi.fn(),
  save: vi.fn(),
  read: vi.fn(),
  mutate: vi.fn(),
  mkdir: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("~/plugins/settings_store", () => ({
  loadPluginSettings: mocks.load,
  savePluginSettings: mocks.save,
}));
vi.mock("~/plugins/document_mutations", () => ({
  readCurrentDocument: mocks.read,
  mutateDocument: mocks.mutate,
}));
vi.mock("~/lib/vault_fs", () => ({ mkdir: mocks.mkdir }));
import { PlannerService } from "./service";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const calendar: ExternalCalendar = {
  id: "main",
  provider: "google",
  title: "Work",
  accountId: "me@example.com",
};
const oldEvent: ExternalItem = {
  id: "old",
  calendarId: "main",
  provider: "google",
  title: "Existing meeting",
  kind: "event",
  allDay: false,
  start: "2026-09-04T10:00:00+09:00",
  end: "2026-09-04T11:00:00+09:00",
};
let services: PlannerService[];
let files: Map<string, string>;
let preferences: PlannerPreferences;
let googleStatus: ConnectionStatus;
let calendarRequest: () => Promise<ExternalCalendar[]>;
let eventRequest: () => Promise<ExternalItem[]>;
let connectRequest: () => Promise<ConnectionStatus>;
let disconnectRequest: () => Promise<void>;
let root: string | null;
let cache: string | undefined;
let pluginFiles: Map<string, string>;
let handlers: Map<string, Set<() => void>>;
let context: PluginContext;
let cacheWrite: ReturnType<typeof vi.fn<(path: string, value: string) => Promise<void>>>;
let vaultWrite: ReturnType<typeof vi.fn>;
let listFiles: ReturnType<typeof vi.fn>;

function emit(event: string) {
  for (const handler of handlers.get(event) ?? []) handler();
}
async function ready() {
  const service = new PlannerService(context);
  services.push(service);
  await service.activate();
  return service;
}
async function waitForCommand(command: string) {
  await vi.waitFor(() =>
    expect(mocks.invoke.mock.calls.some(([name]) => name === command)).toBe(true),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  services = [];
  files = new Map();
  preferences = structuredClone(DEFAULT_PREFERENCES);
  preferences.enabledSources.google = true;
  preferences.selectedCalendars.google = ["main"];
  googleStatus = { provider: "google", connected: true, configured: true };
  calendarRequest = async () => [calendar];
  eventRequest = async () => [oldEvent];
  connectRequest = async () => googleStatus;
  disconnectRequest = async () => {};
  root = "/vault-a";
  handlers = new Map();
  cache = undefined;
  pluginFiles = new Map();
  mocks.load.mockImplementation(async ({ normalize }) => normalize(preferences));
  mocks.save.mockResolvedValue(undefined);
  mocks.mkdir.mockResolvedValue(undefined);
  mocks.read.mockImplementation(async (path: string) => {
    if (!files.has(path)) throw new Error("missing note");
    return files.get(path)!;
  });
  mocks.mutate.mockImplementation(async (path: string, transform: (markdown: string) => string) => {
    files.set(path, transform(files.get(path) ?? ""));
  });
  mocks.invoke.mockImplementation(async (command: string, args?: { kind?: string }) => {
    switch (command) {
      case "planner_google_status":
        return { ...googleStatus };
      case "planner_google_calendars":
        return calendarRequest();
      case "planner_google_events":
        return eventRequest();
      case "planner_google_connect":
        return connectRequest();
      case "planner_google_disconnect":
        return disconnectRequest();
      case "planner_apple_status":
        return {
          provider: args?.kind === "calendar" ? "apple-calendar" : "apple-reminders",
          configured: true,
          connected: false,
        };
      case "planner_apple_revision":
        return 1;
      case "planner_google_suspend":
      case "planner_apple_suspend":
        return undefined;
      default:
        throw new Error(`Unexpected native command: ${command}`);
    }
  });
  cacheWrite = vi.fn(async (path: string, value: string) => {
    if (path === "external-cache.json") cache = value;
    else pluginFiles.set(path, value);
  });
  vaultWrite = vi.fn(async (path: string, value: string) => {
    files.set(path, value);
  });
  listFiles = vi.fn(async () =>
    [...files.keys()].map((path) => ({ path, name: path.split("/").at(-1), is_directory: false })),
  );
  context = {
    fs: {
      exists: async (path: string) =>
        path === "external-cache.json" ? cache !== undefined : pluginFiles.has(path),
      readFile: async (path: string) =>
        path === "external-cache.json" ? cache! : pluginFiles.get(path)!,
      writeFile: cacheWrite,
    },
    vault: {
      get rootPath() {
        return root;
      },
      listFiles,
      exists: async (path: string) => files.has(path),
      writeFile: vaultWrite,
      onFileChanged: async () => vi.fn(),
    },
    events: {
      on: (event: string, handler: () => void) => {
        if (!handlers.has(event)) handlers.set(event, new Set());
        handlers.get(event)!.add(handler);
        return () => handlers.get(event)!.delete(handler);
      },
    },
    track: vi.fn(),
  } as unknown as PluginContext;
});

afterEach(() => {
  for (const service of services) service.dispose();
  vi.useRealTimers();
});

describe("Planner source snapshots and lifecycle", () => {
  it("keeps an unavailable Google source dormant without restoring cached items", async () => {
    googleStatus = { provider: "google", configured: false, connected: false, writable: false };
    const service = await ready();
    expect(service.isSourceAvailable("google")).toBe(false);
    expect(service.isSourceAvailable("apple-calendar")).toBe(true);
    expect(service.isSourceAvailable("apple-reminders")).toBe(true);
    expect(service.state.sources.google.items).toEqual([]);
    expect(service.visibleCalendars("google")).toEqual([]);
    mocks.invoke.mockClear();
    await service.connect("google");
    await service.refreshExternal();
    expect(
      mocks.invoke.mock.calls.some(([command]) => String(command).startsWith("planner_google_")),
    ).toBe(false);
    expect(service.state.preferences.selectedCalendars.google).toEqual(["main"]);
  });

  it("includes Tuesday for a Sunday three-day view while keeping the weekly cache key", async () => {
    const service = await ready();
    service.setAnchor("2026-09-06", 3);
    await service.refreshExternal();
    expect(mocks.invoke).toHaveBeenCalledWith("planner_google_events", {
      calendarIds: ["main"],
      start: new Date("2026-08-31T00:00:00").toISOString(),
      end: new Date("2026-09-09T00:00:00").toISOString(),
      timeZone: new Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    expect(service.state.sources.google.range).toBe("2026-08-31");
    expect(JSON.parse(cache!).sources.google.range).toBe("2026-08-31");
  });

  it("preserves the full-week query for one-day views and the default setAnchor call", async () => {
    const service = await ready();
    service.setAnchor("2026-09-06", 3);
    await service.refreshExternal();
    mocks.invoke.mockClear();
    service.setAnchor("2026-09-06");
    await service.refreshExternal();
    expect(mocks.invoke).toHaveBeenCalledWith("planner_google_events", {
      calendarIds: ["main"],
      start: new Date("2026-08-31T00:00:00").toISOString(),
      end: new Date("2026-09-07T00:00:00").toISOString(),
      timeZone: new Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    mocks.invoke.mockClear();
    service.setAnchor("2026-09-06", 1);
    await service.refreshExternal();
    expect(mocks.invoke).toHaveBeenCalledWith("planner_google_events", {
      calendarIds: ["main"],
      start: new Date("2026-08-31T00:00:00").toISOString(),
      end: new Date("2026-09-07T00:00:00").toISOString(),
      timeZone: new Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
  });

  it("ignores the old range response when visible day count changes at the same anchor", async () => {
    const service = await ready();
    service.setAnchor("2026-09-06", 7);
    const pending = deferred<ExternalItem[]>();
    eventRequest = () => pending.promise;
    mocks.invoke.mockClear();
    const oldRefresh = service.refreshExternal();
    await waitForCommand("planner_google_events");
    service.setAnchor("2026-09-06", 3);
    eventRequest = async () => [{ ...oldEvent, id: "expanded-range" }];
    await service.refreshExternal();
    pending.resolve([{ ...oldEvent, id: "outdated-week" }]);
    await oldRefresh;
    expect(service.state.sources.google.items.map((item) => item.id)).toEqual(["expanded-range"]);
    expect(JSON.parse(cache!).sources.google.items[0].id).toBe("expanded-range");
  });

  it("keeps the previous complete snapshot and timestamp when a later page fails", async () => {
    const service = await ready();
    await service.refreshExternal();
    const before = service.state.sources.google.updatedAt;
    const saved = cache;
    eventRequest = async () => {
      throw new Error("A later page could not be fetched");
    };
    await service.refreshExternal();
    expect(service.state.sources.google.items.map((item) => item.id)).toEqual(["old"]);
    expect(service.state.sources.google.updatedAt).toBe(before);
    expect(service.state.sources.google.error).toContain("later page");
    expect(cache).toBe(saved);
  });

  it("ignores a late event response after disconnect and clears cached metadata", async () => {
    const service = await ready();
    await service.refreshExternal();
    const pending = deferred<ExternalItem[]>();
    eventRequest = () => pending.promise;
    mocks.invoke.mockClear();
    const refresh = service.refreshExternal();
    await waitForCommand("planner_google_events");
    await service.disconnect("google");
    pending.resolve([{ ...oldEvent, id: "late" }]);
    await refresh;
    expect(service.state.sources.google.items).toEqual([]);
    expect(service.state.sources.google.updatedAt).toBeUndefined();
    expect(service.state.sources.google.range).toBeUndefined();
    expect(service.state.preferences.enabledSources.google).toBe(false);
    expect(JSON.parse(cache!).sources.google.items).toEqual([]);
  });

  it("disconnect reaches native even when saving local preferences fails", async () => {
    const service = await ready();
    mocks.save.mockRejectedValueOnce(new Error("Disk unavailable"));
    await expect(service.disconnect("google")).rejects.toThrow("Disk unavailable");
    expect(mocks.invoke).toHaveBeenCalledWith("planner_google_disconnect", {});
    expect(service.state.sources.google.items).toEqual([]);
  });

  it("a delayed OAuth result cannot enable a disconnected source", async () => {
    const service = await ready();
    const pending = deferred<ConnectionStatus>();
    connectRequest = () => pending.promise;
    const connect = service.connect("google");
    await waitForCommand("planner_google_connect");
    await service.disconnect("google");
    pending.resolve({ ...googleStatus, connected: true });
    await connect;
    expect(service.state.preferences.enabledSources.google).toBe(false);
    expect(service.state.sources.google.status.connected).toBe(false);
    expect(service.state.sources.google.calendars).toEqual([]);
  });

  it("a successful consent flow discards previous-account selections before listing calendars", async () => {
    const service = await ready();
    await service.refreshExternal();
    calendarRequest = async () => [{ ...calendar, id: "new-main", accountId: "other@example.com" }];
    await service.connect("google");
    expect(service.state.sources.google.items).toEqual([]);
    expect(service.state.preferences.selectedCalendars.google).toEqual([]);
    expect(service.state.sources.google.calendars[0].accountId).toBe("other@example.com");
  });

  it("removes lost calendars and their cached events after access changes", async () => {
    const service = await ready();
    await service.refreshExternal();
    calendarRequest = async () => [];
    mocks.invoke.mockClear();
    await service.refreshExternal();
    expect(service.state.preferences.selectedCalendars.google).toEqual([]);
    expect(service.state.sources.google.items).toEqual([]);
    expect(mocks.invoke.mock.calls.some(([command]) => command === "planner_google_events")).toBe(
      false,
    );
  });

  it("clears a revoked connection after a fetch fails", async () => {
    const service = await ready();
    await service.refreshExternal();
    eventRequest = async () => {
      googleStatus = { ...googleStatus, connected: false };
      throw new Error("Reconnect Google");
    };
    await service.refreshExternal();
    expect(service.state.sources.google.status.connected).toBe(false);
    expect(service.state.sources.google.items).toEqual([]);
    expect(JSON.parse(cache!).sources.google.items).toEqual([]);
  });

  it("does not display startup cache when keychain access is unavailable", async () => {
    cache = JSON.stringify({
      version: 1,
      sources: { google: { items: [oldEvent], updatedAt: "2026-09-04T00:00:00Z" } },
    });
    googleStatus = { ...googleStatus, connected: false, error: "Keychain unavailable" };
    const service = await ready();
    expect(service.state.sources.google.items).toEqual([]);
    expect(service.state.sources.google.error).toBe("Keychain unavailable");
    expect(JSON.parse(cache!).sources.google.items).toEqual([]);
  });

  it("restores only selected, structurally valid cache records while offline", async () => {
    cache = JSON.stringify({
      version: 1,
      sources: {
        google: {
          items: [
            oldEvent,
            { ...oldEvent, calendarId: "not-selected" },
            { ...oldEvent, start: "invalid" },
          ],
          range: "2026-08-31",
          updatedAt: "2026-09-04T00:00:00Z",
        },
      },
    });
    calendarRequest = async () => {
      throw new Error("Offline");
    };
    const service = await ready();
    expect(service.state.sources.google.items).toEqual([oldEvent]);
    expect(service.state.sources.google.error).toBe("Offline");
  });

  it("deactivation stops listeners, polling, and native OAuth without reconnecting late results", async () => {
    vi.useFakeTimers();
    const service = await ready();
    const pending = deferred<ConnectionStatus>();
    connectRequest = () => pending.promise;
    const connection = service.connect("google");
    const release = service.visible();
    service.dispose();
    const calls = mocks.invoke.mock.calls.length;
    pending.resolve(googleStatus);
    await connection;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    emit("editor:saved");
    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.invoke).toHaveBeenCalledWith("planner_google_suspend");
    expect(mocks.invoke).toHaveBeenCalledWith("planner_apple_suspend");
    expect(mocks.invoke.mock.calls.length).toBe(calls);
    expect([...handlers.values()].every((values) => values.size === 0)).toBe(true);
    release();
    release();
  });

  it("native bridge exposes only reads and connection lifecycle for external sources", async () => {
    const service = await ready();
    await service.refreshExternal();
    await service.disconnect("google");
    const commands = new Set(mocks.invoke.mock.calls.map(([command]) => command));
    expect(
      [...commands].every((command) =>
        /^planner_(google|apple)_(status|calendars|events|items|connect|disconnect|revision|suspend)$/.test(
          command,
        ),
      ),
    ).toBe(true);
  });

  it("waits for the previous plugin instance's settings write before reactivation", async () => {
    const service = await ready();
    const pending = deferred<void>();
    mocks.save.mockReturnValueOnce(pending.promise);
    const disconnect = service.disconnect("google");
    await vi.waitFor(() => expect(mocks.save).toHaveBeenCalled());
    service.dispose();
    const previousLoads = mocks.load.mock.calls.length;
    const replacement = new PlannerService(context);
    services.push(replacement);
    const activation = replacement.activate();
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.load).toHaveBeenCalledTimes(previousLoads);
    pending.resolve();
    await disconnect;
    await activation;
    expect(mocks.load).toHaveBeenCalledTimes(previousLoads + 1);
  });
});

describe("Planner Markdown and vault ownership", () => {
  it("rejects a partial strict scan while preserving the complete tasks and note-link index", async () => {
    files.set("A.md", "- [ ] Original A\n");
    files.set("B.md", linkNote("- [ ] Original B\n", oldEvent));
    const service = await ready();
    const previous = JSON.parse(
      JSON.stringify({
        tasks: service.state.tasks,
        notes: service.state.notes,
        links: service.state.links,
      }),
    );
    files.set("A.md", "- [ ] Changed A\n");
    files.set("C.md", "- [ ] New C\n");
    mocks.read.mockImplementation(async (path: string) => {
      if (path === "B.md") throw new Error("The editor document is temporarily unavailable");
      return files.get(path)!;
    });
    await expect(service.scan({ sync: false, throwOnError: true })).rejects.toThrow(
      "Could not read: B.md",
    );
    expect(service.state.tasks).toEqual(previous.tasks);
    expect(service.state.notes).toEqual(previous.notes);
    expect(service.state.links).toEqual(previous.links);
    expect(service.linkedNotes(oldEvent)).toEqual(["B.md"]);
    expect(service.state.loading).toBe(false);
    expect(mocks.mutate).not.toHaveBeenCalled();
    expect(vaultWrite).not.toHaveBeenCalled();
  });

  it("rejects a superseded strict scan instead of reporting a stale read as successful", async () => {
    files.set("Notes.md", "- [ ] Original\n");
    const service = await ready();
    const pending = deferred<string>();
    mocks.read.mockClear();
    mocks.read.mockImplementationOnce(() => pending.promise);
    const staleScan = service.scan({ sync: false, throwOnError: true });
    await vi.waitFor(() => expect(mocks.read).toHaveBeenCalledWith("Notes.md"));
    files.set("Notes.md", "- [ ] Latest\n");
    await service.scan({ sync: false, throwOnError: true });
    const rejected = expect(staleScan).rejects.toThrow("scan was superseded");
    pending.resolve("- [ ] Old pending document\n");
    await rejected;
    expect(service.state.tasks.map((task) => task.title)).toEqual(["Latest"]);
    expect(service.state.loading).toBe(false);
  });

  it("debounces unsaved document changes and rescans current editor text", async () => {
    vi.useFakeTimers();
    files.set("Notes.md", "- [ ] Original task\n");
    const service = await ready();
    mocks.read.mockClear();
    files.set("Notes.md", "- [ ] Unsaved task title\n");
    emit("editor:documentChanged");
    emit("editor:documentChanged");
    await vi.advanceTimersByTimeAsync(249);
    expect(mocks.read).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.read).toHaveBeenCalledTimes(1);
    expect(service.state.tasks[0].title).toBe("Unsaved task title");
  });

  it("reads current editor content and mutates the note through the shared document owner", async () => {
    files.set("Notes.md", "# Notes\n\n- [ ] Write the proposal\n");
    const service = await ready();
    const task = service.state.tasks[0];
    expect(task.title).toBe("Write the proposal");
    mocks.invoke.mockClear();
    await service.updateTask(task, { checked: true });
    expect(files.get("Notes.md")).toContain("- [x] Write the proposal");
    expect(mocks.mutate).toHaveBeenCalledWith("Notes.md", expect.any(Function));
    expect(vaultWrite).not.toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(service.state.tasks[0].checked).toBe(true);
  });

  it("uses the expected stable identity when equal task titles surround the undo target", async () => {
    files.set(
      "Notes.md",
      '- [ ] Draft <!-- kuku-task: {"id":"first"} -->\n' +
        '- [x] Draft <!-- kuku-task: {"id":"target"} -->\n' +
        '- [x] Draft <!-- kuku-task: {"id":"last"} -->\n',
    );
    const service = await ready();
    const task = service.state.tasks.find((value) => value.metadata?.id === "target")!;
    const expected = JSON.parse(JSON.stringify(task));
    await service.updateTask(task, { checked: false }, expected);
    expect(
      extractTasks(files.get("Notes.md")!, "Notes.md").map((value) => [value.id, value.checked]),
    ).toEqual([
      ["first", false],
      ["target", false],
      ["last", true],
    ]);
  });

  it.each([
    ["completion", '- [ ] Draft <!-- kuku-task: {"id":"target","dueDate":"2026-09-10"} -->\n'],
    ["title", '- [x] New title <!-- kuku-task: {"id":"target","dueDate":"2026-09-10"} -->\n'],
    ["metadata", '- [x] Draft <!-- kuku-task: {"id":"target","dueDate":"2026-09-11"} -->\n'],
    [
      "new metadata",
      '- [x] Draft <!-- kuku-task: {"id":"target","dueDate":"2026-09-10","plannedDate":"2026-09-12"} -->\n',
    ],
    ["removed metadata", '- [x] Draft <!-- kuku-task: {"id":"target"} -->\n'],
  ])(
    "preserves a newer %s change made while an undo waits for the document owner",
    async (_field, latest) => {
      files.set(
        "Notes.md",
        '- [x] Draft <!-- kuku-task: {"id":"target","dueDate":"2026-09-10"} -->\n',
      );
      const service = await ready();
      const task = service.state.tasks[0];
      const expected = JSON.parse(JSON.stringify(task));
      const entered = deferred<void>();
      const release = deferred<void>();
      mocks.mutate.mockImplementationOnce(
        async (path: string, transform: (markdown: string) => string) => {
          entered.resolve();
          await release.promise;
          files.set(path, transform(files.get(path)!));
        },
      );
      mocks.invoke.mockClear();
      const restoring = service.updateTask(task, { checked: false }, expected);
      const rejected = expect(restoring).rejects.toThrow("CONFLICT");
      await entered.promise;
      files.set("Notes.md", latest);
      release.resolve();
      await rejected;
      expect(files.get("Notes.md")).toBe(latest);
      expect(vaultWrite).not.toHaveBeenCalled();
      expect(mocks.invoke).not.toHaveBeenCalled();
    },
  );

  it("allows unrelated unsaved body changes through an inactive document owner without replacing disk text", async () => {
    const original =
      '# Notes\n\n- [x] Draft <!-- kuku-task: {"id":"target","dueDate":"2026-09-10"} -->\n';
    files.set("Notes.md", original);
    let ownerText = original;
    mocks.read.mockImplementation(async () => ownerText);
    const service = await ready();
    const task = service.state.tasks[0];
    const expected = JSON.parse(JSON.stringify(task));
    ownerText = `# Unsaved meeting notes\n\nNew paragraph before the task.\n\n${original}\nTranscript still recording.\n`;
    const latest = ownerText;
    mocks.mutate.mockImplementationOnce(
      async (_path: string, transform: (markdown: string) => string) => {
        ownerText = transform(ownerText);
      },
    );
    await service.updateTask(task, { checked: false }, expected);
    expect(ownerText).toBe(latest.replace("- [x] Draft", "- [ ] Draft"));
    expect(files.get("Notes.md")).toBe(original);
    expect(vaultWrite).not.toHaveBeenCalled();
    expect(mocks.mutate).toHaveBeenCalledWith("Notes.md", expect.any(Function));
    expect(service.state.tasks[0]).toMatchObject({
      checked: false,
      metadata: { id: "target", dueDate: "2026-09-10" },
    });
  });

  it("does not absorb an unscanned external title change into completion undo history", async () => {
    files.set("Notes.md", '- [ ] Original title <!-- kuku-task: {"id":"target"} -->\n');
    const service = await ready();
    const task = service.state.tasks[0];
    const latest = '- [ ] Edited elsewhere <!-- kuku-task: {"id":"target"} -->\n';
    files.set("Notes.md", latest);
    await expect(service.undo.updateTask(task, { checked: true }, "Completed")).rejects.toThrow(
      "CONFLICT",
    );
    expect(files.get("Notes.md")).toBe(latest);
    expect(service.undo.entry()).toBeNull();
  });

  it("excluded folders hide tasks while remaining available for note links", async () => {
    preferences.excludedFolders = ["Archive"];
    files.set("Archive/Meeting.md", linkNote("- [ ] Archived task\n", oldEvent));
    files.set("Current.md", "- [ ] Current task\n");
    const service = await ready();
    expect(service.state.tasks.map((task) => task.title)).toEqual(["Current task"]);
    expect(service.state.notes).toContain("Archive/Meeting.md");
    expect(service.linkedNotes(oldEvent)).toEqual(["Archive/Meeting.md"]);
  });

  it("removes links deleted from frontmatter and clears them on vault close", async () => {
    files.set("Meeting.md", linkNote("# Meeting\n", oldEvent));
    const service = await ready();
    expect(service.linkedNotes(oldEvent)).toEqual(["Meeting.md"]);
    files.set("Meeting.md", "# Meeting\n");
    await service.scan();
    expect(service.linkedNotes(oldEvent)).toEqual([]);
    files.set("Meeting.md", linkNote("# Meeting\n", oldEvent));
    await service.scan();
    root = null;
    emit("vault:closed");
    expect(service.linkedNotes(oldEvent)).toEqual([]);
  });

  it("rejects ambiguous copied metadata before writing either note", async () => {
    files.set("A.md", '- [ ] First <!-- kuku-task: {"id":"duplicate"} -->\n');
    files.set("B.md", '- [ ] Copy <!-- kuku-task: {"id":"duplicate"} -->\n');
    const service = await ready();
    await expect(service.updateTask(service.state.tasks[0], { checked: true })).rejects.toThrow(
      "Duplicate task ID",
    );
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it("a pending scan from an old vault cannot replace tasks from the new vault", async () => {
    const service = await ready();
    const pending = deferred<string>();
    files.set("Old.md", "- [ ] Old task\n");
    mocks.read.mockImplementationOnce(() => pending.promise);
    const scan = service.scan();
    await vi.waitFor(() => expect(mocks.read).toHaveBeenCalledWith("Old.md"));
    root = "/vault-b";
    files.clear();
    files.set("New.md", "- [ ] New task\n");
    emit("vault:opened");
    await service.scan();
    pending.resolve("- [ ] Old task\n");
    await scan;
    expect(service.state.tasks.map((task) => task.title)).toEqual(["New task"]);
    expect(service.state.notes).toEqual(["New.md"]);
  });

  it("switching vaults during directory creation prevents an Inbox write in the new vault", async () => {
    const service = await ready();
    const pending = deferred<void>();
    mocks.mkdir.mockReturnValueOnce(pending.promise);
    const adding = service.addTask("A task from the old vault");
    await vi.waitFor(() => expect(mocks.mkdir).toHaveBeenCalledWith("Tasks"));
    root = "/vault-b";
    emit("vault:opened");
    pending.resolve();
    await expect(adding).rejects.toThrow("vault changed");
    expect(vaultWrite).not.toHaveBeenCalled();
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it("serializes simultaneous quick additions without overwriting the first new Inbox", async () => {
    const service = await ready();
    await Promise.all([service.addTask("First"), service.addTask("Second")]);
    expect(files.get("Tasks/Inbox.md")).toContain("First");
    expect(files.get("Tasks/Inbox.md")).toContain("Second");
    expect(vaultWrite).toHaveBeenCalledTimes(1);
    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    expect(service.state.tasks).toHaveLength(2);
  });
  it("captures task titles literally without interpreting task metadata or Markdown", async () => {
    const service = await ready();
    const title = '**Bold** <!-- kuku-task: {"id":"forged"} --> [label](https://example.com)';
    const ref = await service.addTask(title);
    expect(service.state.tasks).toHaveLength(1);
    expect(service.state.tasks[0].title).toBe(title);
    expect(service.state.tasks[0].metadata?.id).not.toBe("forged");
    expect(ref.kind).toBe("note");
  });
});

describe("Planner external writes and binding recovery", () => {
  let remote: Map<string, ExternalItem>;
  let created: Map<string, ExternalItem>;
  let failCreateResponse: boolean;
  let failUpdateResponse: boolean;
  let beforeDelete: (() => Promise<void>) | undefined;
  beforeEach(() => {
    remote = new Map();
    created = new Map();
    failCreateResponse = false;
    failUpdateResponse = false;
    beforeDelete = undefined;
    googleStatus.writable = true;
    calendarRequest = async () => [{ ...calendar, writable: true }];
    preferences.defaultCalendar = { provider: "google", calendarId: "main" };
    eventRequest = async () => [...remote.values()];
    const base = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
      if (command === "planner_google_get") {
        const ref = args.eventRef as EventRef;
        return (
          remote.get(ref.itemId) ??
          (ref.externalId
            ? [...remote.values()].find(
                (item) =>
                  item.writeRef?.externalId === ref.externalId &&
                  item.calendarId === ref.calendarId,
              )
            : null) ??
          null
        );
      }
      if (command === "planner_google_create") {
        const id = args.operationId as string,
          draft = args.draft as ItemDraft;
        const journal = JSON.parse(pluginFiles.get(journalPath(root!))!);
        expect(journal.operations.some((operation: { id: string }) => operation.id === id)).toBe(
          true,
        );
        let item = created.get(id);
        if (!item) {
          const itemId = `created-${created.size + 1}`;
          item = {
            ...draft,
            id: itemId,
            calendarId: args.calendarId as string,
            provider: "google",
            kind: "event",
            writable: true,
            writeRef: {
              provider: "google",
              calendarId: args.calendarId as string,
              itemId,
              externalId: `uid-${itemId}`,
              version: "1",
            },
          };
          created.set(id, item);
          remote.set(itemId, item);
        }
        if (failCreateResponse) {
          failCreateResponse = false;
          throw new Error("NETWORK: response was lost after creation");
        }
        return item;
      }
      if (command === "planner_google_update") {
        const ref = args.eventRef as EventRef,
          item = remote.get(ref.itemId);
        if (!item) throw new Error("NOT_FOUND: missing");
        if (item.writeRef?.version !== ref.version)
          throw new Error("CONFLICT: external version changed");
        const updated = {
          ...item,
          ...(args.patch as ItemPatch),
          writeRef: { ...ref, version: String(Number(ref.version) + 1) },
        } as ExternalItem;
        remote.set(ref.itemId, updated);
        if (failUpdateResponse) {
          failUpdateResponse = false;
          throw new Error("NETWORK: response was lost after update");
        }
        return updated;
      }
      if (command === "planner_google_delete") {
        await beforeDelete?.();
        const ref = args.eventRef as EventRef,
          item = remote.get(ref.itemId);
        if (!item) throw new Error("NOT_FOUND: missing");
        if (item.writeRef?.version !== ref.version)
          throw new Error("CONFLICT: external version changed");
        remote.delete(ref.itemId);
        return;
      }
      return base(command, args);
    });
    files.set("Tasks.md", '- [ ] Draft <!-- kuku-task: {"id":"task-one"} -->\n');
  });
  const schedule = {
    scheduledStart: "2026-09-04T01:00:00Z",
    scheduledEnd: "2026-09-04T01:30:00Z",
    timeZone: "Asia/Seoul",
  };
  async function scheduled() {
    const service = await ready();
    await service.updateTask(service.state.tasks[0], { metadata: schedule });
    return service;
  }
  it("never publishes to a new default calendar changed during an awaited document mutation", async () => {
    calendarRequest = async () => [
      { ...calendar, writable: true },
      { ...calendar, id: "other", title: "Other calendar", writable: true },
    ];
    const service = await ready();
    const task = service.state.tasks[0];
    const entered = deferred<void>(),
      release = deferred<void>();
    const originalMutate = mocks.mutate.getMockImplementation()!;
    mocks.mutate.mockImplementationOnce(
      async (path: string, transform: (markdown: string) => string) => {
        entered.resolve();
        await release.promise;
        return originalMutate(path, transform);
      },
    );
    const scheduling = service.updateTask(task, { metadata: schedule }, task, {
      provider: "google",
      calendarId: "main",
    });
    const rejected = expect(scheduling).rejects.toThrow("scheduling calendar changed");
    await entered.promise;
    await service.setDefaultCalendar({ provider: "google", calendarId: "other" });
    release.resolve();
    await rejected;
    expect(created.size).toBe(0);
    expect(service.state.timeBlockLinks).toEqual([]);
    expect(service.state.operations).toEqual([]);
    expect(mocks.invoke.mock.calls.some(([command]) => command === "planner_google_create")).toBe(
      false,
    );
    // The document mutation already happened; the guarded service must report
    // the partial local result and must not silently post it to "other".
    expect(service.state.tasks[0].metadata?.scheduledStart).toBe(schedule.scheduledStart);
  });

  it.each(["local note", "reminder"] as const)(
    "rechecks a %s's explicit scheduling destination after waiting in the write queue",
    async (kind) => {
      if (kind === "local note") preferences.defaultCalendar = null;
      calendarRequest = async () => [
        { ...calendar, writable: true },
        { ...calendar, id: "other", title: "Other calendar", writable: true },
      ];
      files.set("Other.md", '- [ ] A separate task <!-- kuku-task: {"id":"other-task"} -->\n');
      const service = await ready();
      const task = service.state.tasks.find((item) => item.metadata?.id === "task-one")!;
      const other = service.state.tasks.find((item) => item.metadata?.id === "other-task")!;
      const originalTask = files.get("Tasks.md");
      const entered = deferred<void>(),
        release = deferred<void>();
      const originalMutate = mocks.mutate.getMockImplementation()!;
      mocks.mutate.mockImplementationOnce(
        async (path: string, transform: (markdown: string) => string) => {
          entered.resolve();
          await release.promise;
          return originalMutate(path, transform);
        },
      );
      const firstWrite = service.updateTask(other, { checked: true }, other);
      await entered.promise;
      const reminder: ExternalItem = {
        id: "reminder-one",
        calendarId: "reminders",
        provider: "apple-reminders",
        kind: "reminder",
        title: "Reminder",
        allDay: true,
        writable: true,
        writeRef: {
          provider: "apple-reminders",
          calendarId: "reminders",
          itemId: "reminder-one",
          version: "1",
        },
      };
      const scheduling =
        kind === "local note"
          ? service.updateTask(task, { metadata: schedule }, task, null)
          : service.scheduleReminder(reminder, schedule, {
              provider: "google",
              calendarId: "main",
            });
      const rejected = expect(scheduling).rejects.toThrow("scheduling calendar changed");
      await service.setDefaultCalendar({ provider: "google", calendarId: "other" });
      release.resolve();
      await firstWrite;
      await rejected;
      expect(files.get("Tasks.md")).toBe(originalTask);
      expect(created.size).toBe(0);
      expect(service.state.timeBlockLinks).toEqual([]);
      expect(mocks.invoke.mock.calls.some(([command]) => command === "planner_google_create")).toBe(
        false,
      );
    },
  );

  it("refreshes local task snapshots without queueing writes in a read-only scan, then syncs normally", async () => {
    // Hold only automatic reconciliation during setup so there is no existing
    // queued sync that could race the read-only request under test.
    const setupSync = vi
      .spyOn(PlannerWriteController.prototype, "queueSync")
      .mockImplementation(() => {});
    let service: PlannerService;
    try {
      service = await scheduled();
    } finally {
      setupSync.mockRestore();
    }
    const queueSync = vi.spyOn(PlannerWriteController.prototype, "queueSync");
    try {
      const eventId = service.state.timeBlockLinks[0].eventRef.itemId;
      files.set("Tasks.md", files.get("Tasks.md")!.replace("Draft", "Changed in the note"));
      const note = files.get("Tasks.md");
      mocks.invoke.mockClear();
      mocks.mutate.mockClear();
      vaultWrite.mockClear();
      await service.scan({ sync: false, throwOnError: true });
      expect(service.state.tasks[0].title).toBe("Changed in the note");
      expect(queueSync).not.toHaveBeenCalled();
      expect(mocks.invoke).not.toHaveBeenCalled();
      expect(mocks.mutate).not.toHaveBeenCalled();
      expect(vaultWrite).not.toHaveBeenCalled();
      expect(files.get("Tasks.md")).toBe(note);
      expect(remote.get(eventId)?.title).toBe("Draft");

      await service.scan();
      expect(queueSync).toHaveBeenCalled();
      await vi.waitFor(() => expect(remote.get(eventId)?.title).toBe("Changed in the note"));
      expect(mocks.invoke.mock.calls.some(([name]) => name === "planner_google_update")).toBe(true);
      expect(created.size).toBe(1);
    } finally {
      queueSync.mockRestore();
    }
  });
  it("publishes an explicitly allocated task once and lazily stores the registry and task link", async () => {
    const service = await scheduled();
    expect(created.size).toBe(1);
    expect(service.state.timeBlockLinks).toHaveLength(1);
    expect(service.state.tasks[0].metadata?.timeBlockLinkId).toBe(
      service.state.timeBlockLinks[0].id,
    );
    expect(readTimeBlockLinks(files.get(BINDINGS_PATH)!)).toHaveLength(1);
    expect(service.state.operations).toEqual([]);
    await service.refreshExternal();
    await service.scan();
    expect(created.size).toBe(1);
  });
  it("never publishes existing unbound scheduled notes during initial indexing or refresh", async () => {
    files.set(
      "Tasks.md",
      `- [ ] Existing <!-- kuku-task: ${JSON.stringify({ id: "task-one", ...schedule })} -->\n`,
    );
    const service = await ready();
    await service.refreshExternal();
    expect(created.size).toBe(0);
    expect(files.has(BINDINGS_PATH)).toBe(false);
    expect(service.state.timeBlockLinks).toEqual([]);
  });
  it("recovers a lost create response with the same operation ID after plugin restart", async () => {
    const service = await ready();
    failCreateResponse = true;
    await expect(
      service.updateTask(service.state.tasks[0], { metadata: schedule }),
    ).rejects.toThrow("NETWORK");
    const id = service.state.operations[0].id;
    await expect(service.dismissOperation(id)).rejects.toThrow("uncertain");
    service.dispose();
    const replacement = await ready();
    expect(replacement.state.operations[0].id).toBe(id);
    await replacement.retryOperation(id);
    expect(created.size).toBe(1);
    expect(replacement.state.timeBlockLinks).toHaveLength(1);
    expect(replacement.state.operations).toEqual([]);
    expect(
      mocks.invoke.mock.calls
        .filter(([command]) => command === "planner_google_create")
        .map(([, args]) => args.operationId),
    ).toEqual([id, id]);
  });
  it("does not call a provider when the write-ahead journal cannot be saved", async () => {
    const service = await ready();
    cacheWrite.mockImplementation(async (path: string, value: string) => {
      if (path.startsWith("write-journal-")) throw new Error("Disk unavailable");
      cache = value;
    });
    await expect(
      service.updateTask(service.state.tasks[0], { metadata: schedule }),
    ).rejects.toThrow("Disk unavailable");
    expect(created.size).toBe(0);
    expect(mocks.invoke.mock.calls.some(([command]) => command === "planner_google_create")).toBe(
      false,
    );
  });
  it.each(["vault", "reconnect"])("cancels a preflight write after a %s change", async (change) => {
    const service = await ready();
    const entered = deferred<void>(),
      release = deferred<void>();
    const original = cacheWrite.getMockImplementation()!;
    let held = false;
    cacheWrite.mockImplementation(async (path, value) => {
      if (!held && path.startsWith("write-journal-")) {
        held = true;
        entered.resolve();
        await release.promise;
      }
      await original(path, value);
    });
    const writing = service.createItem("google", "main", {
      title: "Pending",
      allDay: false,
      start: schedule.scheduledStart,
      end: schedule.scheduledEnd,
    });
    await entered.promise;
    if (change === "vault") {
      root = "/vault-b";
      emit("vault:opened");
    } else {
      await service.disconnect("google");
      await service.connect("google");
    }
    release.resolve();
    await expect(writing).rejects.toThrow(
      change === "vault" ? "vault changed" : "connection changed",
    );
    expect(created.size).toBe(0);
  });
  it("deletes a reviewed task and its block when only Planner's own binding cleanup changes the note", async () => {
    const service = await scheduled();
    const task = JSON.parse(JSON.stringify(service.state.tasks[0]));
    await service.deleteTask(task, true, task);
    expect(remote.size).toBe(0);
    expect(service.state.tasks).toEqual([]);
    expect(service.state.timeBlockLinks).toEqual([]);
    expect(files.get("Tasks.md")).not.toContain("Draft");
  });

  it("checks the latest document before deleting a reviewed task's remote block", async () => {
    const service = await scheduled();
    const task = JSON.parse(JSON.stringify(service.state.tasks[0]));
    const entered = deferred<void>(),
      release = deferred<void>();
    const originalRead = mocks.read.getMockImplementation()!;
    mocks.read.mockImplementationOnce(async (path: string) => {
      entered.resolve();
      await release.promise;
      return originalRead(path);
    });
    mocks.invoke.mockClear();
    const deleting = service.deleteTask(task, true, task);
    const rejected = expect(deleting).rejects.toThrow("CONFLICT");
    await entered.promise;
    const changed = files.get("Tasks.md")!.replace("Draft", "Changed after the AI read");
    files.set("Tasks.md", changed);
    release.resolve();
    await rejected;
    expect(files.get("Tasks.md")).toBe(changed);
    expect(remote.size).toBe(1);
    expect(service.state.timeBlockLinks).toHaveLength(1);
    expect(mocks.invoke.mock.calls.some(([command]) => command === "planner_google_delete")).toBe(
      false,
    );
  });

  it("rechecks the reviewed task inside the document mutation before keeping its block", async () => {
    const service = await scheduled();
    const task = JSON.parse(JSON.stringify(service.state.tasks[0]));
    const entered = deferred<void>(),
      release = deferred<void>();
    const originalMutate = mocks.mutate.getMockImplementation()!;
    mocks.mutate.mockImplementation(
      async (path: string, transform: (markdown: string) => string) => {
        if (path === task.path) {
          entered.resolve();
          await release.promise;
        }
        return originalMutate(path, transform);
      },
    );
    const deleting = service.deleteTask(task, false, task);
    const rejected = expect(deleting).rejects.toThrow("CONFLICT");
    await entered.promise;
    const changed = `${files.get("Tasks.md")}\nNew unsaved meeting text.\n`;
    files.set("Tasks.md", changed);
    release.resolve();
    await rejected;
    expect(files.get("Tasks.md")).toBe(changed);
    expect(remote.size).toBe(1);
    expect(readTimeBlockLinks(files.get(BINDINGS_PATH)!)).toHaveLength(1);
  });

  it("preserves a task edited while its reviewed remote deletion is already in flight", async () => {
    const service = await scheduled();
    const task = JSON.parse(JSON.stringify(service.state.tasks[0]));
    const release = deferred<void>();
    beforeDelete = () => release.promise;
    const deleting = service.deleteTask(task, true, task);
    const rejected = expect(deleting).rejects.toThrow("CONFLICT");
    await waitForCommand("planner_google_delete");
    const changed = files.get("Tasks.md")!.replace("Draft", "Keep this edited task");
    files.set("Tasks.md", changed);
    release.resolve();
    await rejected;
    expect(files.get("Tasks.md")).toBe(changed);
    expect(remote.size).toBe(0);
    expect(service.state.operations).toEqual([
      expect.objectContaining({ type: "delete", stage: "local", status: "conflict" }),
    ]);
  });

  it("keeps the binding if source deletion fails while retaining the calendar event", async () => {
    const service = await scheduled();
    const task = service.state.tasks[0],
      original = mocks.mutate.getMockImplementation()!;
    mocks.mutate.mockImplementation(
      async (path: string, transform: (markdown: string) => string) => {
        if (path === task.path) throw new Error("Protected document");
        return original(path, transform);
      },
    );
    await expect(service.deleteTask(task, false)).rejects.toThrow("Protected document");
    expect(readTimeBlockLinks(files.get(BINDINGS_PATH)!)).toHaveLength(1);
    expect(service.state.tasks[0].metadata?.timeBlockLinkId).toBe(
      service.state.timeBlockLinks[0].id,
    );
    expect(remote.size).toBe(1);
    mocks.mutate.mockImplementation(original);
    await service.deleteTask(task, false);
    expect(service.state.timeBlockLinks).toEqual([]);
    expect(service.state.tasks).toEqual([]);
    expect(remote.size).toBe(1);
  });
  it("keeps newly saved items from unselected calendars out of the displayed snapshot", async () => {
    const service = await ready();
    await service.selectCalendar("google", "main", false);
    await service.createItem("google", "main", {
      title: "Hidden calendar",
      allDay: false,
      start: schedule.scheduledStart,
      end: schedule.scheduledEnd,
    });
    expect(created.size).toBe(1);
    expect(service.state.sources.google.items).toEqual([]);
  });
  it("preserves a deleted event binding until its reviewed replacement is journaled and saved", async () => {
    const service = await scheduled();
    const link = service.state.timeBlockLinks[0];
    remote.delete(link.eventRef.itemId);
    files.set("Tasks.md", files.get("Tasks.md")!.replace("Draft", "Keep this task"));
    await service.scan();
    await vi.waitFor(() => expect(service.state.timeBlockLinks[0].status).toBe("conflict"));
    const reviewed = {
      title: "Keep this task",
      start: schedule.scheduledStart,
      end: schedule.scheduledEnd,
    };
    const original = cacheWrite.getMockImplementation()!;
    cacheWrite.mockImplementation(async (path, value) => {
      if (path.startsWith("write-journal-")) throw new Error("Disk unavailable");
      return original(path, value);
    });
    await expect(service.resolveLink(link.id, "task", undefined, reviewed)).rejects.toThrow(
      "Disk unavailable",
    );
    expect(readTimeBlockLinks(files.get(BINDINGS_PATH)!)[0].eventRef.itemId).toBe(
      link.eventRef.itemId,
    );
    cacheWrite.mockImplementation(original);
    await service.resolveLink(link.id, "task", undefined, reviewed);
    expect(service.state.timeBlockLinks).toHaveLength(1);
    expect(service.state.timeBlockLinks[0].id).toBe(link.id);
    expect(service.state.timeBlockLinks[0].eventRef.itemId).not.toBe(link.eventRef.itemId);
    expect(remote.size).toBe(1);
  });
  it("cancels reviewed conflict resolution when its connection changes during the point-read", async () => {
    const service = await scheduled();
    const link = service.state.timeBlockLinks[0],
      item = remote.get(link.eventRef.itemId)!;
    const changed = {
      ...item,
      title: "Remote edit",
      writeRef: { ...item.writeRef!, version: "2" },
    };
    remote.set(item.id, changed);
    files.set("Tasks.md", files.get("Tasks.md")!.replace("Draft", "Local edit"));
    await service.scan();
    await vi.waitFor(() => expect(service.state.timeBlockLinks[0].status).toBe("conflict"));
    const entered = deferred<void>(),
      release = deferred<ExternalItem>();
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command, args) => {
      if (command === "planner_google_get") {
        entered.resolve();
        return release.promise;
      }
      return original(command, args);
    });
    const resolving = service.resolveLink(link.id, "event", "2", {
      title: "Local edit",
      start: schedule.scheduledStart,
      end: schedule.scheduledEnd,
    });
    await entered.promise;
    await service.disconnect("google");
    release.resolve(changed);
    await expect(resolving).rejects.toThrow("connection changed");
    expect(service.state.tasks[0].title).toBe("Local edit");
    expect(files.get("Tasks.md")).toContain("Local edit");
  });
  it("recovers a lost update response by point-read without performing the update twice", async () => {
    const service = await scheduled();
    const item = [...remote.values()][0];
    failUpdateResponse = true;
    await expect(service.updateItem(item, { title: "Edited meeting" })).rejects.toThrow("NETWORK");
    const id = service.state.operations[0].id;
    await service.retryOperation(id);
    expect(
      mocks.invoke.mock.calls.filter(([command]) => command === "planner_google_update"),
    ).toHaveLength(1);
    expect(service.state.tasks[0].title).toBe("Edited meeting");
    expect(service.state.operations).toEqual([]);
  });
  it("pulls a moved block by exact reference even when it is absent from the displayed week", async () => {
    const service = await scheduled();
    const [id, item] = [...remote.entries()][0];
    remote.set(id, {
      ...item,
      title: "Moved outside week",
      start: "2026-10-01T01:00:00Z",
      end: "2026-10-01T02:00:00Z",
      writeRef: { ...item.writeRef!, version: "2" },
    });
    eventRequest = async () => [];
    await service.refreshExternal();
    await vi.waitFor(() => expect(service.state.tasks[0].title).toBe("Moved outside week"));
    expect(service.state.tasks[0].metadata?.scheduledStart).toBe("2026-10-01T01:00:00Z");
    expect(service.state.timeBlockLinks).toHaveLength(1);
  });
  it("preserves both sides when the note and external block changed concurrently", async () => {
    const service = await scheduled();
    const [id, item] = [...remote.entries()][0];
    remote.set(id, {
      ...item,
      title: "Remote edit",
      writeRef: { ...item.writeRef!, version: "2" },
    });
    files.set("Tasks.md", files.get("Tasks.md")!.replace("Draft", "Local edit"));
    mocks.invoke.mockClear();
    await service.scan();
    await vi.waitFor(() => expect(service.state.timeBlockLinks[0].status).toBe("conflict"));
    expect(service.state.tasks[0].title).toBe("Local edit");
    expect(remote.get(id)?.title).toBe("Remote edit");
    expect(mocks.invoke.mock.calls.some(([command]) => command === "planner_google_update")).toBe(
      false,
    );
  });
  it("does not clear a new local allocation made while deletion is in flight", async () => {
    const service = await scheduled();
    const pending = deferred<void>();
    beforeDelete = () => pending.promise;
    const removing = service.updateTask(service.state.tasks[0], {
      metadata: { scheduledStart: undefined, scheduledEnd: undefined },
    });
    await waitForCommand("planner_google_delete");
    const markdown = files.get("Tasks.md")!;
    files.set(
      "Tasks.md",
      updateTaskMarkdown(markdown, extractTasks(markdown, "Tasks.md")[0], {
        metadata: { scheduledStart: "2026-09-05T01:00:00Z", scheduledEnd: "2026-09-05T02:00:00Z" },
      }),
    );
    await service.scan();
    pending.resolve();
    await expect(removing).rejects.toThrow("CONFLICT");
    expect(service.state.tasks[0].metadata?.scheduledStart).toBe("2026-09-05T01:00:00Z");
    expect(service.state.operations[0].stage).toBe("local");
  });
  it("returns the confirmed task when later publishing fails and blocks a second pending create", async () => {
    const service = await ready();
    failCreateResponse = true;
    const ref = await service.addTask("New source", { metadata: schedule });
    expect(ref.kind).toBe("note");
    expect(service.state.error).toContain("NETWORK");
    const task = service.state.tasks.find((task) => task.title === "New source")!;
    await expect(service.updateTask(task, { metadata: schedule })).rejects.toThrow("pending");
    expect(created.size).toBe(1);
    await service.retryOperation(service.state.operations[0].id);
    expect(service.state.tasks.filter((task) => task.title === "New source")).toHaveLength(1);
    expect(created.size).toBe(1);
  });
  it("resolves a reviewed two-sided conflict without moving the deadline", async () => {
    const service = await scheduled();
    const [id, item] = [...remote.entries()][0];
    remote.set(id, {
      ...item,
      title: "Remote choice",
      start: "2026-09-06T01:00:00Z",
      end: "2026-09-06T02:00:00Z",
      writeRef: { ...item.writeRef!, version: "2" },
    });
    const before = files.get("Tasks.md")!;
    files.set(
      "Tasks.md",
      updateTaskMarkdown(before, extractTasks(before, "Tasks.md")[0], {
        title: "Local choice",
        metadata: { dueDate: "2026-09-10" },
      }),
    );
    await service.scan();
    await vi.waitFor(() => expect(service.state.timeBlockLinks[0].status).toBe("conflict"));
    const link = service.state.timeBlockLinks[0];
    const reviewed = {
      title: "Local choice",
      start: schedule.scheduledStart,
      end: schedule.scheduledEnd,
    };
    await expect(service.resolveLink(link.id, "event", "old-version", reviewed)).rejects.toThrow(
      "CONFLICT",
    );
    await service.resolveLink(link.id, "event", "2", reviewed);
    expect(service.state.tasks[0].title).toBe("Remote choice");
    expect(service.state.tasks[0].metadata?.dueDate).toBe("2026-09-10");
    expect(service.state.tasks[0].metadata?.scheduledStart).toBe("2026-09-06T01:00:00Z");
    expect(service.state.timeBlockLinks[0].status).toBe("synced");
  });
  it("keeps newer note edits when a remote pull waited in the document mutation queue", async () => {
    const service = await scheduled();
    const [id, item] = [...remote.entries()][0];
    remote.set(id, { ...item, title: "Remote", writeRef: { ...item.writeRef!, version: "2" } });
    const base = mocks.mutate.getMockImplementation()!;
    mocks.mutate.mockImplementationOnce(
      async (path: string, transform: (markdown: string) => string) => {
        files.set(path, files.get(path)!.replace("Draft", "Typed while waiting"));
        return base(path, transform);
      },
    );
    await service.refreshExternal();
    await vi.waitFor(() => expect(service.state.timeBlockLinks[0].status).toBe("conflict"));
    expect(files.get("Tasks.md")).toContain("Typed while waiting");
  });
  it("rejects default calendars without write access and groups connectors only by explicit aliases", async () => {
    const service = await ready();
    googleStatus.writable = false;
    await service.refreshExternal();
    await expect(
      service.setDefaultCalendar({ provider: "google", calendarId: "main" }),
    ).rejects.toThrow("writable");
    googleStatus.writable = true;
    await service.refreshExternal();
    await service.setCalendarAlias("google", "main", "Team");
    await service.setPreferredConnector("Team", "google");
    expect(service.calendarLabel(service.state.sources.google.calendars[0])).toBe("Team");
    expect(service.visibleCalendars("google")).toHaveLength(1);
    expect(service.state.preferences.preferredConnectors?.Team).toBe("google");
  });
  it("preserves a linked task when its original calendar disappears from the connected account", async () => {
    const service = await scheduled();
    calendarRequest = async () => [];
    remote.clear();
    mocks.invoke.mockClear();
    await service.refreshExternal();
    await vi.waitFor(() => expect(service.state.timeBlockLinks[0].status).toBe("missing"));
    expect(service.state.tasks[0].metadata?.scheduledStart).toBe(schedule.scheduledStart);
    expect(service.state.timeBlockLinks).toHaveLength(1);
    expect(mocks.invoke.mock.calls.some(([command]) => command === "planner_google_get")).toBe(
      false,
    );
  });
  it("migrates a sync-changed raw ID only after point lookup confirms the original external identity", async () => {
    const service = await scheduled();
    const [oldID, item] = [...remote.entries()][0];
    remote.delete(oldID);
    remote.set("new-native-id", {
      ...item,
      id: "new-native-id",
      writeRef: { ...item.writeRef!, itemId: "new-native-id", version: "2" },
    });
    await service.scan();
    await vi.waitFor(() =>
      expect(service.state.timeBlockLinks[0].eventRef.itemId).toBe("new-native-id"),
    );
    expect(service.state.tasks[0].metadata?.scheduledStart).toBe(schedule.scheduledStart);
    expect(readTimeBlockLinks(files.get(BINDINGS_PATH)!)[0].eventRef.itemId).toBe("new-native-id");
  });
  it("does not publish through a manually hidden alternate connector", async () => {
    preferences.calendarAliases = { '["google","main"]': "Shared" };
    preferences.preferredConnectors = { Shared: "apple-calendar" };
    const service = await ready();
    await expect(
      service.updateTask(service.state.tasks[0], { metadata: schedule }),
    ).rejects.toThrow("preferred connector");
    expect(created.size).toBe(0);
  });
});
