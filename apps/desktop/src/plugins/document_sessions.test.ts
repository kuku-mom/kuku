// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Schema } from "prosekit/pm/model";
import { EditorState } from "prosekit/pm/state";
import { RetainedDocument, type DocumentHost } from "./document_sessions";
import {
  createMeetingTranscriptPlugin,
  getMeetingPluginState,
  setMeetingPluginState,
} from "./builtin/meeting_notes/meeting_transcript_plugin";

const io = vi.hoisted(() => ({ write: vi.fn(), dirty: vi.fn(), vault: { rootPath: "/vault" } }));
vi.mock("~/stores/vault", () => ({ vaultState: io.vault, writeFileWithChecksum: io.write }));
vi.mock("~/stores/files", () => ({
  filesState: { tabs: [{ id: "a" }] },
  markTabDirty: io.dirty,
  saveCachedChecksum: vi.fn(),
  saveCachedContent: vi.fn(),
}));
vi.mock("~/plugins/markdown_service", () => ({
  getMarkdownService: () => ({ stringify: (doc: unknown) => JSON.stringify(doc) }),
}));
function host() {
  const schema = new Schema({
    nodes: { doc: { content: "paragraph+" }, paragraph: { content: "text*" }, text: {} },
  });
  let state = EditorState.create({
    schema,
    doc: schema.node("doc", null, [schema.node("paragraph", null, schema.text("Original"))]),
    plugins: [createMeetingTranscriptPlugin()],
  });
  return {
    tabId: "a",
    filePath: "a.md",
    vaultRoot: "/vault",
    getState: () => state,
    dispatch: (tr) => {
      state = state.applyTransaction(tr).state;
    },
    restore: (next) => {
      state = next;
    },
    saved: vi.fn(),
    isDisposed: () => false,
  } satisfies DocumentHost;
}
beforeEach(() => {
  io.write.mockReset();
  io.dirty.mockClear();
  io.vault.rootPath = "/vault";
});

describe("retained document saving", () => {
  it("routes edits from document-ready callbacks into the newly attached view", () => {
    const document = new RetainedDocument(host(), "first");
    document.detach();
    const replacement = host();
    const restore = replacement.restore;
    replacement.restore = (state) => {
      restore(state);
      document.dispatch(document.getState().tr.insertText("Ready ", 1));
    };
    document.attach(replacement);
    expect(replacement.getState().doc.textContent).toBe("Ready Original");
    expect(document.getState().doc).toBe(replacement.getState().doc);
  });

  it("reattaches immediately during a slow save and keeps editing with the committed checksum", async () => {
    const document = new RetainedDocument(host(), "first");
    document.detach();
    let finish!: () => void;
    io.write.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ status: "Written", checksum: "second" });
        }),
    );
    io.write.mockResolvedValue({ status: "Written", checksum: "third" });
    const saving = document.save();
    await vi.waitFor(() => expect(io.write).toHaveBeenCalledTimes(1));
    const replacement = host();
    const restore = vi.spyOn(replacement, "restore");
    document.attach(replacement);
    try {
      await Promise.resolve();
      expect(restore).toHaveBeenCalled();
      replacement.dispatch(replacement.getState().tr.insertText("Continued ", 1));
    } finally {
      finish();
      await saving;
    }
    expect(document.getState().doc.textContent).toBe("Continued Original");
    expect(io.write.mock.calls.at(-1)?.[1]).toContain("Continued Original");
    expect(io.write.mock.calls.at(-1)?.[2]).toBe("second");
    expect(replacement.saved).toHaveBeenLastCalledWith("third");
  });

  it("serializes detached writes with the last committed checksum", async () => {
    const editor = host();
    const document = new RetainedDocument(editor, "first");
    document.detach();
    let finish!: () => void;
    io.write.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ status: "Written", checksum: "second" });
        }),
    );
    io.write.mockResolvedValue({ status: "Written", checksum: "third" });
    const first = document.save();
    await vi.waitFor(() => expect(io.write).toHaveBeenCalledTimes(1));
    document.dispatch(document.getState().tr.insertText("Latest ", 1));
    const second = document.save();
    expect(io.write).toHaveBeenCalledTimes(1);
    finish();
    await first;
    await second;
    expect(io.write.mock.calls[1][2]).toBe("second");
    expect(io.write.mock.calls[1][1]).toContain("Latest Original");
    expect(document.getChecksum()).toBe("third");
  });

  it("restores the latest detached state and range into the replacement schema", () => {
    const document = new RetainedDocument(host(), "first");
    document.dispatch(
      setMeetingPluginState(document.getState().tr, {
        sessionId: "meeting",
        from: 0,
        to: 10,
        partial: "live",
      }),
    );
    document.detach();
    const replacement = host();
    const schema = replacement.getState().schema;
    document.attach(replacement);
    expect(document.getState().schema).toBe(schema);
    expect(getMeetingPluginState(replacement.getState())?.sessionId).toBe("meeting");
    expect(getMeetingPluginState(replacement.getState())?.partial).toBe("live");
  });

  it("does not write after the vault changes and does not acknowledge conflicts", async () => {
    const document = new RetainedDocument(host(), "first");
    io.write.mockResolvedValue({ status: "Conflict", expected: "first", actual: "external" });
    const conflict = await document.save();
    expect(conflict.status).toBe("conflict");
    expect(document.getChecksum()).toBe("first");
    io.vault.rootPath = "/other";
    const wrongVault = await document.save();
    expect(wrongVault.status).toBe("error");
    expect(io.write).toHaveBeenCalledTimes(1);
  });

  it("journals the exact snapshot before writing and preserves dirty edits during a save", async () => {
    const editor = host();
    const document = new RetainedDocument(editor, "first");
    const order: string[] = [];
    document.beforeSave = async (snapshot) => {
      order.push("journal");
      expect(snapshot.content).toContain("Original");
      if (order.length === 1) editor.dispatch(editor.getState().tr.insertText("New ", 1));
    };
    io.write.mockImplementation(async () => {
      order.push("write");
      return { status: "Written", checksum: "second" };
    });
    await document.save();
    expect(order).toEqual(["journal", "write", "journal", "write"]);
    expect(io.dirty).toHaveBeenCalledWith("a", false);
    expect(document.getState().doc.textContent).toBe("New Original");
  });

  it("does not attach a disposed view", () => {
    const document = new RetainedDocument(host(), "first");
    document.detach();
    const deadHost = { ...host(), isDisposed: () => true, restore: vi.fn(), dispatch: vi.fn() };
    document.attach(deadHost);
    document.dispatch(document.getState().tr.insertText("Alive ", 1));
    expect(deadHost.restore).not.toHaveBeenCalled();
    expect(deadHost.dispatch).not.toHaveBeenCalled();
    expect(document.getState().doc.textContent).toBe("Alive Original");
  });
});
