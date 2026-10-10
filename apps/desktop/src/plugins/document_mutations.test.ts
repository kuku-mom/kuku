import { beforeEach, describe, expect, it, vi } from "vitest";
import { Schema } from "prosekit/pm/model";
import { EditorState, type Transaction } from "prosekit/pm/state";
import {
  documentChangeTransaction,
  focusTask,
  mutateDocument,
  readCurrentDocument,
} from "./document_mutations";
import { extractTasks } from "~/lib/planner_tasks";
import { emitEvent } from "./events";
import {
  createMeetingTranscriptPlugin,
  getMeetingPluginState,
  setMeetingPluginState,
} from "./builtin/meeting_notes/meeting_transcript_plugin";

const io = vi.hoisted(() => ({
  root: { rootPath: "/vault" as string | null },
  tabs: [] as { id: string; type: string; filePath: string; isDirty: boolean }[],
  cached: null as unknown,
  checksum: "cached-checksum",
  session: null as unknown,
  retained: null as unknown,
  markdownReady: true,
  activeTabId: "planner" as string | null,
  readyHandlers: new Set<() => void>(),
  open: vi.fn(),
  read: vi.fn(),
  readWithChecksum: vi.fn(),
  write: vi.fn(),
  save: vi.fn(),
}));
vi.mock("~/stores/vault", () => ({ vaultState: io.root }));
vi.mock("~/lib/vault_fs", () => ({
  readFileWithChecksum: io.readWithChecksum,
  readVaultFile: async (path: string) => {
    const result = await io.read(path);
    return result.content;
  },
  writeFileWithChecksum: io.write,
}));
vi.mock("~/stores/editor", () => ({
  getEditorDocumentSession: (path?: string) => {
    const session = io.session as { filePath?: string } | null;
    return path && session?.filePath && path !== session.filePath ? null : session;
  },
  onEditorDocumentReady: (handler: () => void) => {
    io.readyHandlers.add(handler);
    return () => io.readyHandlers.delete(handler);
  },
}));
vi.mock("./document_sessions", () => ({ getRetainedDocument: () => io.retained }));
vi.mock("~/stores/files", () => ({
  filesState: {
    tabs: io.tabs,
    get activeTabId() {
      return io.activeTabId;
    },
  },
  getCachedChecksum: () => io.checksum,
  getCachedContent: () => io.cached,
  markTabDirty: (id: string, dirty: boolean) => {
    const tab = io.tabs.find((entry) => entry.id === id);
    if (tab) tab.isDirty = dirty;
  },
  saveCachedChecksum: (_id: string, checksum: string) => {
    io.checksum = checksum;
  },
  saveCachedContent: (_id: string, doc: unknown) => {
    io.cached = doc;
  },
  openTab: io.open,
}));
vi.mock("./markdown_service", () => ({
  getMarkdownService: () =>
    io.markdownReady ? { stringify: JSON.stringify, parse: JSON.parse } : null,
}));

const schema = new Schema({
  nodes: { doc: { content: "paragraph+" }, paragraph: { content: "text*" }, text: {} },
});
const document = (text: string) =>
  schema.node("doc", null, [schema.node("paragraph", null, schema.text(text))]);
const transform = (markdown: string) => {
  const parsed = JSON.parse(markdown);
  parsed.content[0].content[0].text += " planned";
  return JSON.stringify(parsed);
};

function openDocument(text: string, reject = false, path = "a.md") {
  let state = EditorState.create({ schema, doc: document(text) });
  const host = {
    vaultRoot: "/vault",
    getState: () => state,
    dispatch: (tr: Transaction) => {
      if (!reject) state = state.applyTransaction(tr).state;
    },
    isDisposed: () => false,
    saved: vi.fn(),
  };
  io.save.mockImplementation(async () => ({
    status: "saved",
    content: JSON.stringify(state.doc.toJSON()),
    checksum: "saved",
  }));
  io.session = { tabId: path, filePath: path, getHost: () => host, save: io.save };
  return host;
}

beforeEach(() => {
  io.root.rootPath = "/vault";
  io.tabs.splice(0);
  io.cached = null;
  io.checksum = "cached-checksum";
  io.session = null;
  io.retained = null;
  io.markdownReady = true;
  io.activeTabId = "planner";
  io.readyHandlers.clear();
  io.open.mockReset().mockImplementation((_title: string, path: string) => {
    io.tabs.push({ id: path, filePath: path, type: "editor", isDirty: false });
    io.activeTabId = path;
    io.session = { tabId: path, filePath: path, getHost: () => null };
  });
  io.read.mockReset().mockResolvedValue({
    content: JSON.stringify(document("Disk").toJSON()),
    checksum: "disk-checksum",
  });
  io.write.mockReset().mockResolvedValue({ status: "Written", checksum: "written-checksum" });
  io.readWithChecksum.mockReset().mockImplementation((path: string) => io.read(path));
  io.save.mockReset();
});

describe("shared document mutations", () => {
  it("reads disk notes during plugin activation before the Markdown service is built", async () => {
    io.markdownReady = false;
    expect(await readCurrentDocument("a.md")).toContain("Disk");
    expect(io.readWithChecksum).not.toHaveBeenCalled();
  });

  it("changes task attributes without replacing a retained transcript inside the list", () => {
    const taskSchema = new Schema({
      nodes: {
        doc: { content: "list+" },
        list: {
          content: "paragraph+",
          attrs: { checked: { default: false }, taskMetadata: { default: null } },
        },
        paragraph: { content: "text*" },
        text: {},
      },
    });
    let state = EditorState.create({
      schema: taskSchema,
      doc: taskSchema.node("doc", null, [
        taskSchema.node("list", { taskMetadata: { id: "task" } }, [
          taskSchema.node("paragraph", null, taskSchema.text("Protected transcript")),
        ]),
      ]),
      plugins: [createMeetingTranscriptPlugin()],
    });
    state = state.apply(
      setMeetingPluginState(state.tr, { sessionId: "recording", from: 2, to: 22, partial: "" }),
    );
    const json = structuredClone(state.doc.toJSON());
    json.content[0].attrs.checked = true;
    const transaction = documentChangeTransaction(state, JSON.stringify(json));
    if (!transaction) throw new Error("Missing task transaction");
    const next = state.applyTransaction(transaction).state;
    expect(next.doc.child(0).attrs.checked).toBe(true);
    expect(next.doc.child(0).firstChild).toBe(state.doc.child(0).firstChild);
    expect(getMeetingPluginState(next)).toMatchObject({ from: 2, to: 22 });
  });

  it("uses and saves current editor content without reading stale disk content", async () => {
    const host = openDocument("Unsaved");
    await mutateDocument("a.md", transform);
    expect(host.getState().doc.textContent).toBe("Unsaved planned");
    expect(io.save).toHaveBeenCalledOnce();
    expect(io.read).not.toHaveBeenCalled();
    expect(io.write).not.toHaveBeenCalled();
  });

  it("reports protected range rejection without claiming the document was saved", async () => {
    openDocument("Protected", true);
    await expect(mutateDocument("a.md", transform)).rejects.toThrow(/protected/);
    expect(io.save).not.toHaveBeenCalled();
  });

  it("routes a retained document through its existing owner and save queue", async () => {
    io.tabs.push({ id: "a", type: "editor", filePath: "a.md", isDirty: true });
    let state = EditorState.create({ schema, doc: document("Transcript and task") });
    io.retained = {
      vaultRoot: "/vault",
      getState: () => state,
      dispatch: (tr: Transaction) => {
        state = state.applyTransaction(tr).state;
      },
      save: io.save.mockResolvedValue({ status: "saved", content: "", checksum: "retained" }),
    };
    expect(await readCurrentDocument("a.md")).toContain("Transcript and task");
    await mutateDocument("a.md", transform);
    expect(state.doc.textContent).toBe("Transcript and task planned");
    expect(io.save).toHaveBeenCalledOnce();
    expect(io.write).not.toHaveBeenCalled();
  });

  it("preserves unsaved inactive-tab content and its expected checksum", async () => {
    io.tabs.push({ id: "a", type: "editor", filePath: "a.md", isDirty: true });
    io.cached = document("Cached unsaved").toJSON();
    expect(await readCurrentDocument("a.md")).toContain("Cached unsaved");
    await mutateDocument("a.md", transform);
    expect(io.write).toHaveBeenCalledWith(
      "a.md",
      expect.stringContaining("Cached unsaved planned"),
      "cached-checksum",
    );
    expect(io.tabs[0].isDirty).toBe(false);
    expect(io.checksum).toBe("written-checksum");
    expect(io.read).not.toHaveBeenCalled();
  });

  it("keeps both unsaved edits and the planner change recoverable after a conflict", async () => {
    io.tabs.push({ id: "a", type: "editor", filePath: "a.md", isDirty: true });
    io.cached = document("Cached unsaved").toJSON();
    io.write.mockResolvedValue({ status: "Conflict", expected: "old", actual: "external" });
    await expect(mutateDocument("a.md", transform)).rejects.toThrow(/conflict/);
    expect(JSON.stringify(io.cached)).toContain("Cached unsaved planned");
    expect(io.tabs[0].isDirty).toBe(true);
    expect(io.checksum).toBe("cached-checksum");
  });

  it("rechecks live state if a note opens during the asynchronous disk read", async () => {
    let finish!: (value: unknown) => void;
    io.read.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = mutateDocument("a.md", transform);
    await vi.waitFor(() => expect(io.read).toHaveBeenCalledOnce());
    const host = openDocument("New unsaved");
    finish({ content: JSON.stringify(document("Old disk").toJSON()), checksum: "old" });
    await pending;
    expect(host.getState().doc.textContent).toBe("New unsaved planned");
    expect(io.write).not.toHaveBeenCalled();
  });

  it("does not use stale clean-tab cache instead of current disk content", async () => {
    io.tabs.push({ id: "a", type: "editor", filePath: "a.md", isDirty: false });
    io.cached = document("Old cached").toJSON();
    await mutateDocument("a.md", transform);
    expect(io.write).toHaveBeenCalledWith(
      "a.md",
      expect.stringContaining("Disk planned"),
      "disk-checksum",
    );
  });

  it("does not write through an editor that is still mounting from an older cache", async () => {
    io.session = { getHost: () => null };
    await expect(mutateDocument("a.md", transform)).rejects.toThrow(/loading/);
    expect(io.write).not.toHaveBeenCalled();
  });

  it("serializes independent planner changes to the same live document", async () => {
    const host = openDocument("Task");
    await Promise.all([mutateDocument("a.md", transform), mutateDocument("a.md", transform)]);
    expect(host.getState().doc.textContent).toBe("Task planned planned");
  });
});

describe("source navigation ownership", () => {
  const task = (path = "a.md") => extractTasks("- [ ] Task\n", path)[0];

  it("waits for the initial viewport restore, then focuses the requested task for typing", async () => {
    const source = '- [ ] First\n- [ ] Target <!-- kuku-task: {"id":"target-task"} -->\n';
    const target = extractTasks(source, "a.md")[1];
    const taskSchema = new Schema({
      nodes: {
        doc: { content: "list+" },
        list: {
          content: "paragraph+",
          attrs: { kind: { default: "task" }, taskMetadata: { default: null } },
        },
        paragraph: { content: "text*" },
        text: {},
      },
    });
    let state = EditorState.create({
      schema: taskSchema,
      doc: taskSchema.node("doc", null, [
        taskSchema.node("list", null, [
          taskSchema.node("paragraph", null, taskSchema.text("First")),
        ]),
        taskSchema.node("list", { taskMetadata: { id: "target-task" } }, [
          taskSchema.node("paragraph", null, taskSchema.text("Target")),
        ]),
      ]),
    });
    let layoutReady = false;
    const focusedAt: number[] = [];
    const host = {
      vaultRoot: "/vault",
      getState: () => state,
      dispatch: (transaction: Transaction) => {
        state = state.apply(transaction);
      },
      isDisposed: () => false,
      isReadyForFocus: () => layoutReady,
      focus: () => focusedAt.push(state.selection.from),
    };
    io.read.mockResolvedValue({ content: source, checksum: "a" });
    io.open.mockImplementation(() => {
      io.tabs.push({ id: "a.md", filePath: "a.md", type: "editor", isDirty: false });
      io.activeTabId = "a.md";
      io.session = { tabId: "a.md", filePath: "a.md", getHost: () => host };
    });
    const pending = focusTask(target);
    await vi.waitFor(() => expect(io.open).toHaveBeenCalledOnce());
    for (const handler of io.readyHandlers) handler();
    expect(focusedAt).toEqual([]);
    layoutReady = true;
    for (const handler of io.readyHandlers) handler();
    await pending;
    expect(focusedAt).toEqual([state.doc.child(0).nodeSize + 2]);
    expect(state.selection.$from.parent.textContent).toBe("Target");
    expect(io.readyHandlers.size).toBe(0);
  });

  it("never opens a relative path in a new vault after a delayed source read", async () => {
    let finish!: (result: unknown) => void;
    io.read.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = focusTask(task());
    await vi.waitFor(() => expect(io.read).toHaveBeenCalledOnce());
    io.root.rootPath = "/different-vault";
    emitEvent("vault:opened", { rootPath: "/different-vault" });
    finish({ content: "- [ ] Task\n", checksum: "old" });
    await pending;
    expect(io.open).not.toHaveBeenCalled();
    expect(io.readyHandlers.size).toBe(0);
  });

  it("lets a newer task click supersede an older slow read", async () => {
    const finish = new Map<string, (result: unknown) => void>();
    io.read.mockImplementation(
      (path: string) => new Promise((resolve) => finish.set(path, resolve)),
    );
    io.open.mockImplementation((_title: string, path: string) => {
      io.tabs.push({ id: path, filePath: path, type: "editor", isDirty: false });
      io.activeTabId = path;
      openDocument("Task", false, path);
    });
    const first = focusTask(task("a.md"));
    const second = focusTask(task("b.md"));
    finish.get("b.md")?.({ content: "- [ ] Task\n", checksum: "b" });
    await second;
    finish.get("a.md")?.({ content: "- [ ] Task\n", checksum: "a" });
    await first;
    expect(io.open).toHaveBeenCalledTimes(1);
    expect(io.open).toHaveBeenCalledWith("b.md", "b.md", "editor");
    expect(io.readyHandlers.size).toBe(0);
  });

  it("cancels a pending ready callback when the user navigates away", async () => {
    io.read.mockResolvedValue({ content: "- [ ] Task\n", checksum: "a" });
    const pending = focusTask(task());
    await vi.waitFor(() => expect(io.open).toHaveBeenCalledOnce());
    io.activeTabId = "other-tab";
    emitEvent("editor:activeChanged", { filePath: null });
    await pending;
    expect(io.readyHandlers.size).toBe(0);
    io.activeTabId = "a.md";
    const host = openDocument("Task");
    const dispatch = vi.spyOn(host, "dispatch");
    for (const handler of io.readyHandlers) handler();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("expires an intended navigation without leaving a late cursor jump", async () => {
    vi.useFakeTimers();
    io.read.mockResolvedValue({ content: "- [ ] Task\n", checksum: "a" });
    const pending = focusTask(task());
    const rejected = expect(pending).rejects.toThrow(/did not become ready/);
    try {
      await vi.advanceTimersByTimeAsync(8000);
      await rejected;
      expect(io.readyHandlers.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a stale active editor host from another vault", async () => {
    const host = openDocument("Old vault unsaved");
    host.vaultRoot = "/old-vault";
    expect(await readCurrentDocument("a.md")).toContain("Disk");
    expect(io.read).toHaveBeenCalledOnce();
  });
});
