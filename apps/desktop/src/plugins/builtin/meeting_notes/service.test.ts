import { Schema } from "prosekit/pm/model";
import { EditorState, type Transaction } from "prosekit/pm/state";
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { editorCoreMarkdown } from "~/plugins/builtin/core_editor/markdown_handlers";
import { RetainedDocument, type DocumentHost } from "~/plugins/document_sessions";
import {
  buildMarkdownService,
  contributeMarkdown,
  getMarkdownService,
} from "~/plugins/markdown_service";
import { allowOperation } from "~/plugins/operation_guards";
import type { PluginContext } from "~/plugins/types";

import { createMeetingTranscriptPlugin } from "./meeting_transcript_plugin";
import { MeetingService, meetingUi, setMeetingUi } from "./service";
import {
  IDLE_MEETING,
  type DocumentCheckpoint,
  type MeetingJournal,
  type MeetingState,
  type MeetingTarget,
  type Transcript,
} from "./types";

const ipc = vi.hoisted(() => ({
  invoke: vi.fn(),
  write: vi.fn(),
  dirty: false,
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: ipc.invoke, isTauri: () => true }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, callback: (event: { payload: unknown }) => void) => {
    ipc.listeners.set(name, callback);
    return () => {
      ipc.listeners.delete(name);
    };
  },
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ show: async () => {}, setFocus: async () => {} }),
}));
vi.mock("~/stores/vault", () => ({
  vaultState: { rootPath: "/vault" },
  writeFileWithChecksum: ipc.write,
}));
vi.mock("~/stores/files", () => ({
  filesState: { tabs: [{ id: "original" }] },
  getActiveTab: () => ({ isDirty: ipc.dirty }),
  markTabDirty: (_id: string, dirty: boolean) => {
    ipc.dirty = dirty;
  },
  saveCachedChecksum: vi.fn(),
  saveCachedContent: vi.fn(),
}));

function markdown() {
  const service = getMarkdownService();
  if (!service) throw new Error("Markdown service not initialized");
  return service;
}
function editor(text: string) {
  const schema = new Schema({
    nodes: {
      doc: { content: "block+" },
      text: { group: "inline" },
      paragraph: { content: "inline*", group: "block" },
      heading: { content: "inline*", group: "block", attrs: { level: { default: 2 } } },
    },
    marks: { bold: {} },
  });
  let state = EditorState.create({
    schema,
    doc: schema.nodeFromJSON(markdown().parse(text)),
    plugins: [createMeetingTranscriptPlugin()],
  });
  return {
    tabId: "original",
    filePath: "original.md",
    vaultRoot: "/vault",
    getState: () => state,
    dispatch: (tr: Transaction) => {
      state = state.applyTransaction(tr).state;
    },
    restore: (next: EditorState) => {
      state = next;
    },
    saved: () => {},
    isDisposed: () => false,
  } satisfies DocumentHost;
}
function send(name: string, payload: unknown) {
  ipc.listeners.get(`meeting-notes://${name}`)?.({ payload });
}

let disk: string, checksum: string, journal: MeetingJournal | null, nativeState: MeetingState;
let service: MeetingService,
  ctx: PluginContext,
  host: DocumentHost,
  retained: RetainedDocument | undefined;
let available: boolean,
  resourcesReady: boolean,
  conflict: boolean,
  permission: string,
  diskSpace: boolean,
  suppressEvents: boolean,
  failAck: boolean,
  emptyFinal: boolean;
let editorSession: NonNullable<PluginContext["editor"]["documentSession"]>;

function result(): Transcript {
  if (emptyFinal)
    return {
      sessionId: journal?.sessionId ?? "",
      kind: "final",
      stableText: "",
      unstableText: "",
      speakerId: null,
      segments: [],
      speakerLimitWarning: false,
    };
  return {
    sessionId: journal?.sessionId ?? "",
    kind: "final",
    stableText: "All meeting words are preserved.",
    unstableText: "",
    speakerId: null,
    segments: [
      { speaker: 1, text: "All meeting words" },
      { speaker: 2, text: "are preserved." },
    ],
    speakerLimitWarning: false,
  };
}

beforeEach(() => {
  contributeMarkdown("meeting-service-test", editorCoreMarkdown);
  buildMarkdownService();
  disk = "Original notes.\n";
  checksum = "initial";
  journal = null;
  nativeState = { ...IDLE_MEETING };
  available = true;
  resourcesReady = false;
  conflict = false;
  permission = "authorized";
  diskSpace = true;
  suppressEvents = false;
  failAck = false;
  emptyFinal = false;
  ipc.dirty = false;
  ipc.invoke.mockReset();
  ipc.write.mockReset();
  ipc.listeners.clear();
  retained = undefined;
  setMeetingUi({
    available: false,
    loaded: false,
    busy: false,
    setup: false,
    consent: false,
    panel: false,
    guard: false,
    mode: "combined",
    detectionEnabled: true,
    detected: null,
    state: { ...IDLE_MEETING },
    resources: null,
    error: "",
    info: "",
    target: "",
  });
  host = editor(disk);
  editorSession = {
    tabId: "original",
    filePath: "original.md",
    getHost: () => host,
    getChecksum: () => checksum,
    save: vi.fn(async () => ({ status: "saved" as const, content: disk, checksum })),
    reloadFromDisk: vi.fn(),
  };
  ctx = {
    editor: {
      documentSession: editorSession,
      retainDocument: () => {
        retained = new RetainedDocument(host, checksum);
        return retained;
      },
    },
    vault: {
      rootPath: "/vault",
      readFileWithChecksum: async () => ({ content: disk, checksum }),
      onFileChanged: async () => () => {},
    },
  } as unknown as PluginContext;
  ipc.write.mockImplementation(async (_path: string, content: string, expected: string) => {
    if (conflict || expected !== checksum)
      return { status: "Conflict", expected, actual: "external" };
    disk = content;
    checksum += "+";
    return { status: "Written", checksum };
  });
  ipc.invoke.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
    switch (command) {
      case "plugin_get_settings":
        return {};
      case "meeting_notes_available":
        return available;
      case "meeting_notes_resources":
        return {
          ready: resourcesReady,
          diskSpaceSufficient: diskSpace,
          estimatedDownloadBytes: 1760000000,
        };
      case "meeting_notes_status":
        return { ...nativeState };
      case "meeting_notes_recoveries":
        return journal ? [structuredClone(journal)] : [];
      case "meeting_notes_discard_recovery":
        if (journal?.sessionId === args.sessionId) journal = null;
        return undefined;
      case "meeting_notes_request_microphone_permission":
        return permission;
      case "meeting_notes_detection_capture_target":
        return null;
      case "meeting_notes_start":
        journal = {
          sessionId: String(args.sessionId),
          target: args.target as MeetingTarget,
          checkpoint: args.checkpoint as DocumentCheckpoint,
          transcript: null,
        };
        nativeState = { ...IDLE_MEETING, phase: "recording", sessionId: journal.sessionId };
        return { ...nativeState };
      case "meeting_notes_stop": {
        if (!journal) throw new Error("Missing journal");
        journal.transcript = result();
        nativeState.phase = "saving";
        if (!suppressEvents) {
          send("state", { ...nativeState });
          send("transcript", result());
        }
        return { ...nativeState };
      }
      case "meeting_notes_checkpoint":
        if (!journal) throw new Error("Missing journal");
        journal.checkpoint = args.checkpoint as DocumentCheckpoint;
        return undefined;
      case "meeting_notes_ack":
        if (!journal?.checkpoint.finalized || disk !== journal.checkpoint.content || failAck)
          throw new Error("Disk not acknowledged");
        journal = null;
        nativeState = { ...IDLE_MEETING };
        return undefined;
      case "meeting_notes_cancel":
        if (args.discard) journal = null;
        nativeState = { ...IDLE_MEETING };
        return { ...nativeState };
      default:
        return undefined;
    }
  });
  service = new MeetingService(ctx);
});
afterEach(async () => {
  await service.dispose();
  vi.useRealTimers();
});

async function start() {
  await service.activate();
  await service.requestStart();
  setMeetingUi("consent", true);
  await service.start();
  expect(meetingUi.state.phase).toBe("recording");
}

describe("meeting document lifecycle", () => {
  it("deletes stale temporary recording data during activation", async () => {
    journal = {
      sessionId: "stale-session",
      target: { vaultRoot: "/vault", filePath: "original.md", title: "Old meeting" },
      checkpoint: {
        content: "Original notes.\n",
        expectedChecksum: "initial",
        doc: host.getState().doc.toJSON(),
        from: 0,
        to: 0,
        finalized: false,
      },
      transcript: null,
    };

    await service.activate();

    expect(journal).toBeNull();
    expect(ipc.invoke).toHaveBeenCalledWith("meeting_notes_discard_recovery", {
      sessionId: "stale-session",
    });
  });

  it("coalesces repeated cancellation and ignores a final arriving during cancellation", async () => {
    await start();
    const normal = ipc.invoke.getMockImplementation();
    if (!normal) throw new Error("Expected IPC mock");
    let cancel!: () => void;
    ipc.invoke.mockImplementation(async (command, args) => {
      if (command === "meeting_notes_cancel")
        await new Promise<void>((resolve) => {
          cancel = resolve;
        });
      return normal(command, args);
    });
    const first = service.cancelRecording();
    const second = service.cancelRecording();
    send("transcript", result());
    expect(ipc.invoke).not.toHaveBeenCalledWith("meeting_notes_ack", expect.anything());
    cancel();
    await Promise.all([first, second]);
    expect(ipc.invoke.mock.calls.filter(([name]) => name === "meeting_notes_cancel")).toHaveLength(
      1,
    );
    expect(meetingUi.state.phase).toBe("idle");
    expect(meetingUi.panel).toBe(false);
    expect(journal).toBeNull();
    expect(disk).toBe("Original notes.\n");
    expect(ipc.invoke).toHaveBeenCalledWith("meeting_notes_cancel", {
      sessionId: expect.any(String),
      discard: true,
    });
  });

  it("discards a failed capture, removes its empty section, and keeps the error visible", async () => {
    await start();
    send("state", {
      ...nativeState,
      phase: "error",
      errorCode: "permission_or_capture",
      message: "Permission denied",
    });

    await vi.waitFor(() => expect(meetingUi.error).not.toBe(""));
    expect(journal).toBeNull();
    expect(disk).toBe("Original notes.\n");
    expect(meetingUi.panel).toBe(true);
    expect(meetingUi.state.errorCode).toBe("permission_or_capture");
  });

  it("does not start from stale readiness after a resource check fails, and allows retry", async () => {
    resourcesReady = true;
    await service.activate();
    const normal = ipc.invoke.getMockImplementation();
    if (!normal) throw new Error("Expected IPC mock");
    ipc.invoke.mockImplementation(async (command, args) => {
      if (command === "meeting_notes_resources") throw new Error("Disk unavailable");
      return normal(command, args);
    });
    await service.toggle();
    expect(meetingUi.setup).toBe(false);
    expect(ipc.invoke).not.toHaveBeenCalledWith("meeting_notes_start", expect.anything());
    ipc.invoke.mockImplementation(normal);
    await service.toggle();
    expect(meetingUi.state.phase).toBe("recording");
  });

  it("ignores delayed state and transcript events after successful saving", async () => {
    await start();
    const final = result();
    await service.finish();
    const savedDisk = disk;
    send("state", {
      ...IDLE_MEETING,
      sessionId: final.sessionId,
      phase: "error",
      errorCode: "worker_exit",
    });
    send("transcript", final);
    expect(meetingUi.state.phase).toBe("idle");
    expect(meetingUi.error).toBe("");
    expect(disk).toBe(savedDisk);
  });

  it("serializes cancellation behind a pending final save acknowledgement", async () => {
    await start();
    const normal = ipc.invoke.getMockImplementation();
    if (!normal) throw new Error("Expected IPC mock");
    let acknowledge!: () => void;
    ipc.invoke.mockImplementation(async (command, args) => {
      if (command === "meeting_notes_ack")
        await new Promise<void>((resolve) => {
          acknowledge = resolve;
        });
      return normal(command, args);
    });
    const finishing = service.finish();
    await vi.waitFor(() => expect(acknowledge).toBeTypeOf("function"));
    const stopping = service.cancelRecording();
    acknowledge();
    expect(await finishing).toBe(true);
    await stopping;
    expect(journal).toBeNull();
    expect(ipc.invoke).not.toHaveBeenCalledWith("meeting_notes_cancel", expect.anything());
    expect(meetingUi.state.phase).toBe("idle");
  });

  it("starts and saves with the toolbar alone after models are ready", async () => {
    resourcesReady = true;
    await service.activate();
    await service.toggle();
    expect(meetingUi.setup).toBe(false);
    expect(meetingUi.state.phase).toBe("recording");
    await service.toggle();
    expect(meetingUi.state.phase).toBe("idle");
    expect(disk).toContain("All meeting words");
    expect(disk).toContain("are preserved.");
  });

  it("removes the meeting section when a successful recording has no speech", async () => {
    emptyFinal = true;
    await start();

    expect(await service.finish()).toBe(true);

    expect(disk).toBe("Original notes.\n");
    expect(journal).toBeNull();
    expect(meetingUi.state.phase).toBe("idle");
    expect(meetingUi.info).toBe("");
    expect(ipc.invoke).toHaveBeenCalledWith("meeting_notes_ack", {
      sessionId: expect.any(String),
    });
  });

  it("still waits for download consent on the first toolbar click", async () => {
    await service.activate();
    await service.toggle();
    expect(meetingUi.setup).toBe(true);
    expect(ipc.invoke).not.toHaveBeenCalledWith("meeting_notes_start", expect.anything());
    expect(ipc.invoke).not.toHaveBeenCalledWith("meeting_notes_request_microphone_permission");
  });

  it("does not enable detection, request permission or download on unsupported hosts", async () => {
    available = false;
    await service.activate();
    await service.requestStart();
    expect(ipc.invoke.mock.calls.map(([command]) => command)).toEqual([
      "plugin_get_settings",
      "meeting_notes_available",
    ]);
    expect(retained).toBeUndefined();
  });

  it("refuses capture when saving existing edits fails", async () => {
    editorSession.save = vi.fn().mockResolvedValue({
      status: "conflict",
      expected: "initial",
      actual: "external",
    });
    await service.activate();
    await service.requestStart();
    expect(retained).toBeUndefined();
    expect(meetingUi.setup).toBe(false);
    expect(ipc.invoke).not.toHaveBeenCalledWith("meeting_notes_start", expect.anything());
  });

  it.each(["consent", "space", "permission"])("does not start without %s", async (missing) => {
    if (missing === "space") diskSpace = false;
    if (missing === "permission") permission = "denied";
    await service.activate();
    await service.requestStart();
    setMeetingUi("consent", missing !== "consent");
    await service.start();
    expect(ipc.invoke).not.toHaveBeenCalledWith("meeting_notes_start", expect.anything());
    expect(disk).toBe("Original notes.\n");
  });

  it("saves only the original detached document and ignores duplicate final events", async () => {
    await start();
    const other = editor("Other tab notes.");
    retained?.detach();
    const document = retained;
    if (!document) throw new Error("Missing retained document");
    document.dispatch(document.getState().tr.insertText("Edited ", 1));
    expect(await allowOperation({ kind: "close-tab", tabId: "other" })).toBe(true);
    const final = result();
    expect(await service.finish()).toBe(true);
    send("transcript", final);
    send("transcript", final);
    expect(disk).toContain("Edited Original notes.");
    expect(disk).toContain("All meeting words");
    expect(other.getState().doc.textContent).toBe("Other tab notes.");
    expect(disk.match(/^## /gmu)).toHaveLength(1);
    expect(
      ipc.invoke.mock.calls.filter(([command]) => command === "meeting_notes_ack"),
    ).toHaveLength(1);
  });

  it("holds vault navigation until the final disk write and acknowledgement complete", async () => {
    await start();
    let commit: (() => void) | undefined;
    ipc.write.mockImplementationOnce(
      (_path, content) =>
        new Promise((resolve) => {
          commit = () => {
            disk = content;
            checksum += "+";
            resolve({ status: "Written", checksum });
          };
        }),
    );
    const moving = allowOperation({ kind: "change-vault" });
    service.answerGuard(true);
    await vi.waitFor(() => expect(commit).toBeTypeOf("function"));
    expect(journal).not.toBeNull();
    expect(meetingUi.state.phase).toBe("saving");
    commit?.();
    expect(await moving).toBe(true);
    expect(journal).toBeNull();
  });

  it("discards a final save conflict and leaves the existing disk document untouched", async () => {
    await start();
    conflict = true;
    const closing = allowOperation({ kind: "close-tab", tabId: "original" });
    service.answerGuard(true);
    expect(await closing).toBe(false);
    await vi.waitFor(() => expect(meetingUi.error).not.toBe(""));
    expect(journal).toBeNull();
    expect(disk).toBe("Original notes.\n");
    expect(meetingUi.state.errorCode).toBe("save_failed");
  });

  it("keeps a saved document and removes temporary data when acknowledgement fails", async () => {
    await start();
    failAck = true;

    expect(await service.finish()).toBe(true);

    expect(disk).toContain("All meeting words");
    expect(journal).toBeNull();
    expect(meetingUi.state.phase).toBe("idle");
  });

  it("recovers a lost final event from the durable journal", async () => {
    vi.useFakeTimers();
    await start();
    suppressEvents = true;
    const finishing = service.finish();
    await vi.advanceTimersByTimeAsync(2000);
    expect(await finishing).toBe(true);
    expect(disk).toContain("All meeting words");
    expect(journal).toBeNull();
  });

  it("discards unfinished transcription and audio when the plugin is disposed", async () => {
    await start();
    suppressEvents = true;
    await ipc.invoke("meeting_notes_stop");
    await service.dispose();
    expect(disk).toBe("Original notes.\n");
    expect(journal).toBeNull();
    expect(ipc.invoke).toHaveBeenCalledWith("meeting_notes_cancel", {
      sessionId: expect.any(String),
      discard: true,
    });
  });
});
