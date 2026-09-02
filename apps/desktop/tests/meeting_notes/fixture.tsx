// Development-only fixture: synthetic transcripts and in-memory IPC, no microphone or network.
import { render } from "solid-js/web";
import { createSignal } from "solid-js";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import { Schema } from "prosekit/pm/model";
import { EditorState, type Transaction } from "prosekit/pm/state";
import { MeetingService, setMeetingService } from "../../src/plugins/builtin/meeting_notes/service";
import {
  MeetingOverlays,
  MeetingSettings,
  MeetingStatus,
  MeetingToolbar,
} from "../../src/plugins/builtin/meeting_notes/ui";
import { createMeetingTranscriptPlugin } from "../../src/plugins/builtin/meeting_notes/meeting_transcript_plugin";
import { RetainedDocument } from "../../src/plugins/document_sessions";
import { allowOperation } from "../../src/plugins/operation_guards";
import { openVault } from "../../src/stores/vault";
import { openTab } from "../../src/stores/files";
import {
  buildMarkdownService,
  contributeMarkdown,
  getMarkdownService,
} from "../../src/plugins/markdown_service";
import { editorCoreMarkdown } from "../../src/plugins/builtin/core_editor/markdown_handlers";
import type { PluginContext } from "../../src/plugins/types";
import type {
  MeetingJournal,
  MeetingTarget,
  DocumentCheckpoint,
} from "../../src/plugins/builtin/meeting_notes/types";
import "../../src/index.css";

Object.defineProperty(window, "isTauri", { value: true, configurable: true });
mockWindows("main");
let phase = "idle",
  sessionId: string | null = null,
  version = 0;
let disk = "Original project notes.\n";
let journal: MeetingJournal | null = null;
let conflict = false;
let ticker: number | undefined;
const [visibleDocument, setVisibleDocument] = createSignal("Original project notes.");
const [diskView, setDiskView] = createSignal(disk);
const [tabName, setTabName] = createSignal("original.md");
const [checks, setChecks] = createSignal("Synthetic capture only. No real audio is recorded.");
const snapshot = () => ({
  phase,
  sessionId,
  progress: null,
  message: null,
  errorCode: null,
  startedAtMs: Date.now(),
  microphoneOnly: false,
  systemOnly: false,
});
mockIPC(
  async (command, raw) => {
    const args = raw as {
      sessionId: string;
      target: MeetingTarget;
      checkpoint: DocumentCheckpoint;
      checksum: string;
      content: string;
    };
    if (command === "plugin_get_settings") return {};
    if (command === "plugin_save_settings" || command === "meeting_notes_enable") return undefined;
    if (command === "meeting_notes_available") return true;
    if (command === "meeting_notes_resources")
      return {
        ready: false,
        runtimeReady: false,
        transcriptionModelReady: false,
        speakerModelReady: false,
        estimatedDownloadBytes: 1760000000,
        estimatedInstalledBytes: 1760000000,
        availableDiskBytes: 50000000000,
        diskSpaceSufficient: true,
      };
    if (command === "meeting_notes_status") return snapshot();
    if (command === "meeting_notes_recoveries") return journal ? [journal] : [];
    if (command === "meeting_notes_request_microphone_permission") return "authorized";
    if (command === "meeting_notes_detection_capture_target") return null;
    if (command === "vault_read_with_checksum") return { content: disk, checksum: String(version) };
    if (command === "vault_list_dir")
      return [{ name: "original.md", path: "original.md", is_directory: false }];
    if (command === "vault_write_with_checksum") {
      if (conflict || args.checksum !== String(version))
        return { status: "Conflict", expected: args.checksum, actual: "external" };
      disk = args.content;
      version++;
      setDiskView(disk);
      return { status: "Written", checksum: String(version) };
    }
    if (command === "meeting_notes_start") {
      sessionId = args.sessionId;
      phase = "recording";
      journal = {
        sessionId: args.sessionId,
        target: args.target,
        checkpoint: args.checkpoint,
        transcript: null,
      };
      ticker = window.setInterval(() => {
        const payload = {
          sessionId: sessionId ?? "",
          kind: "update" as const,
          stableText: "오늘 회의에서는 출시 일정을 논의했습니다.",
          unstableText: "다음 주에는",
          speakerId: 1,
          segments: [],
          speakerLimitWarning: false,
        };
        if (journal) journal.transcript = payload;
        void emit("meeting-notes://transcript", payload);
      }, 1000);
      return snapshot();
    }
    if (command === "meeting_notes_stop") {
      window.clearInterval(ticker);
      phase = "saving";
      const payload = {
        sessionId: sessionId ?? "",
        kind: "final" as const,
        stableText: "오늘 회의에서는 출시 일정을 논의했습니다. 다음 주에는 테스트를 완료합니다.",
        unstableText: "",
        speakerId: null,
        segments: [
          { speaker: 1, text: "오늘 회의에서는 출시 일정을 논의했습니다." },
          { speaker: 2, text: "다음 주에는 테스트를 완료합니다." },
        ],
        speakerLimitWarning: false,
      };
      if (journal) journal.transcript = payload;
      await emit("meeting-notes://state", snapshot());
      void emit("meeting-notes://transcript", payload);
      return snapshot();
    }
    if (command === "meeting_notes_checkpoint") {
      if (journal) journal.checkpoint = args.checkpoint;
      return undefined;
    }
    if (command === "meeting_notes_ack") {
      if (!journal || disk !== journal.checkpoint.content) throw new Error("ACK before disk save");
      journal = null;
      phase = "idle";
      sessionId = null;
      setChecks("Verified: disk save completed before recovery cleanup.");
      return undefined;
    }
    if (command === "meeting_notes_cancel") {
      window.clearInterval(ticker);
      phase = "idle";
      return snapshot();
    }
    return null;
  },
  { shouldMockEvents: true },
);
contributeMarkdown("fixture-core", editorCoreMarkdown);
buildMarkdownService();
const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    text: { group: "inline" },
    paragraph: { content: "inline*", group: "block" },
    heading: { content: "inline*", group: "block", attrs: { level: { default: 2 } } },
  },
  marks: { bold: {} },
});
const markdown = getMarkdownService();
if (!markdown) throw new Error("Markdown fixture failed to initialize");
let state = EditorState.create({
  schema,
  doc: schema.nodeFromJSON(markdown.parse(disk)),
  plugins: [createMeetingTranscriptPlugin()],
});
const host = {
  tabId: "fixture",
  filePath: "original.md",
  vaultRoot: "/fixture",
  getState: () => state,
  dispatch: (tr: Transaction) => {
    state = state.applyTransaction(tr).state;
    if (tabName() === "original.md") setVisibleDocument(state.doc.textContent);
  },
  restore: (next: EditorState) => {
    state = next;
    setVisibleDocument(state.doc.textContent);
  },
  saved: () => {},
  isDisposed: () => false,
};
let retained: RetainedDocument | undefined;
const editorSession = {
  filePath: "original.md",
  tabId: "fixture",
  getHost: () => host,
  save: async () => ({ status: "saved", content: disk, checksum: String(version) }),
};
const ctx = {
  editor: {
    documentSession: editorSession,
    retainDocument: () => {
      retained = new RetainedDocument(host, String(version));
      return retained;
    },
  },
  vault: {
    rootPath: "/fixture",
    onFileChanged: async () => () => {},
    readFileWithChecksum: async () => ({ content: disk, checksum: String(version) }),
  },
} as unknown as PluginContext;
await openVault("/fixture");
openTab("original.md", "original.md");
const service = new MeetingService(ctx);
setMeetingService(service);
await service.activate();
const container = document.getElementById("fixture");
if (!container) throw new Error("Fixture container is missing");
render(
  () => (
    <main style={{ padding: "32px", "max-width": "1000px", margin: "auto" }}>
      <header
        style={{ display: "flex", "align-items": "center", "justify-content": "space-between" }}
      >
        <h1>Meeting Notes · UI fixture</h1>
        <MeetingToolbar />
      </header>
      <p style={{ "margin-top": "12px", color: "var(--color-text-muted)" }}>{checks()}</p>
      <div class="meeting-actions">
        <button
          class="meeting-button"
          onClick={() => {
            retained?.detach();
            setTabName("other.md");
            setVisibleDocument("This second document must remain unchanged.");
          }}
        >
          Switch to another tab
        </button>
        <button
          class="meeting-button"
          onClick={() => {
            setTabName("original.md");
            if (retained) retained.attach(host);
          }}
        >
          Return to original
        </button>
        <button
          class="meeting-button"
          onClick={() => {
            void allowOperation({ kind: "close-tab", tabId: "fixture" }).then((allowed) =>
              setChecks(
                allowed
                  ? "Verified: closing allowed after saving."
                  : "Closing canceled; document retained.",
              ),
            );
          }}
        >
          Close recording document
        </button>
        <label>
          <input
            type="checkbox"
            onChange={(event) => {
              conflict = event.currentTarget.checked;
            }}
          />{" "}
          Simulate save conflict
        </label>
      </div>
      <h2 style={{ "margin-top": "24px" }}>{tabName()}</h2>
      <p
        style={{ "min-height": "100px", padding: "20px", border: "1px solid var(--color-border)" }}
      >
        {visibleDocument()}
      </p>
      <MeetingStatus />
      <MeetingSettings />
      <h2>Saved Markdown</h2>
      <pre style={{ "white-space": "pre-wrap" }}>{diskView()}</pre>
      <MeetingOverlays />
    </main>
  ),
  container,
);
