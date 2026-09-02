import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { createStore } from "solid-js/store";

import type { RetainedDocument, DocumentSnapshot } from "~/plugins/document_sessions";
import { getMarkdownService } from "~/plugins/markdown_service";
import { registerOperationGuard, type GuardedOperation } from "~/plugins/operation_guards";
import { createPluginSettings, type PluginSettingsHandle } from "~/plugins/settings_store";
import type { PluginContext, Disposer } from "~/plugins/types";

import {
  MeetingDetectionPromptCoordinator,
  type MeetingCaptureTarget,
  type MeetingDetectionSnapshot,
} from "./detection_prompt";
import { MeetingDocumentBridge } from "./document_bridge";
import { getMeetingPluginState } from "./meeting_transcript_plugin";
import { mt } from "./messages";
import {
  IDLE_MEETING,
  type AudioMode,
  type DocumentCheckpoint,
  type MeetingJournal,
  type MeetingResources,
  type MeetingState,
  type MeetingTarget,
  type Transcript,
} from "./types";

interface MeetingSettings {
  detection: boolean;
  consentVersion: number;
  mode: AudioMode;
}
interface Session {
  id: string;
  target: MeetingTarget;
  document: RetainedDocument;
  bridge: MeetingDocumentBridge;
  native: boolean;
  finalized: boolean;
  finalPayload?: Transcript;
  emptyFinal?: boolean;
  finish?: Promise<boolean>;
  saving?: Promise<boolean>;
  cancelling?: Promise<void>;
  resolveFinish?: (saved: boolean) => void;
}

function hasTranscriptText(payload: Transcript): boolean {
  return Boolean(
    payload.stableText.trim() || payload.segments.some((segment) => segment.text.trim()),
  );
}

const [meetingUi, setUi] = createStore({
  available: false,
  loaded: false,
  busy: false,
  setup: false,
  consent: false,
  panel: false,
  guard: false,
  mode: "combined" as AudioMode,
  detectionEnabled: true,
  detected: null as MeetingDetectionSnapshot | null,
  state: { ...IDLE_MEETING },
  resources: null as MeetingResources | null,
  error: "",
  info: "",
  target: "",
});

export class MeetingService {
  private session: Session | null = null;
  private settings?: PluginSettingsHandle<MeetingSettings>;
  private readonly disposers: Disposer[] = [];
  private readonly detection = new MeetingDetectionPromptCoordinator();
  private disposed = false;
  private guardResolve?: (value: boolean) => void;
  private pendingCapture: MeetingCaptureTarget | null = null;
  private reconciling = false;

  private readonly ctx: PluginContext;
  constructor(ctx: PluginContext) {
    this.ctx = ctx;
  }

  async activate(): Promise<void> {
    if (!isTauri()) {
      setUi("loaded", true);
      return;
    }
    this.settings = await createPluginSettings<MeetingSettings>({
      pluginId: "meeting-notes",
      defaults: { detection: true, consentVersion: 0, mode: "combined" },
    });
    const available = await invoke<boolean>("meeting_notes_available");
    setUi({
      available,
      loaded: true,
      detectionEnabled: this.settings.settings.detection,
      consent: this.settings.settings.consentVersion === 1,
      mode: this.settings.settings.mode,
    });
    if (!available) return;
    // Subscribe before enabling detection or requesting state snapshots.
    this.disposers.push(
      await listen<MeetingState>("meeting-notes://state", ({ payload }) => {
        if (this.disposed) return;
        // A late state event must not resurrect a finished/cancelled session.
        if (
          !this.session ||
          this.session.cancelling ||
          (payload.sessionId && payload.sessionId !== this.session.id)
        )
          return;
        setUi("state", payload);
        if (payload.phase === "error") {
          const failed = this.session;
          if (failed) void this.discardErroredSession(failed, payload);
        }
      }),
    );
    const checkpointTimer = window.setInterval(() => {
      void this.reconcile().catch((error: unknown) => this.report(error));
    }, 2000);
    this.disposers.push(() => window.clearInterval(checkpointTimer));
    this.disposers.push(
      await listen<Transcript>("meeting-notes://transcript", ({ payload }) => {
        void this.onTranscript(payload).catch((error: unknown) => this.report(error));
      }),
    );
    this.disposers.push(
      await listen<MeetingDetectionSnapshot>("meeting-notes://detection", ({ payload }) => {
        this.onDetection(payload);
      }),
    );
    this.disposers.push(
      await listen("meeting-notes://exit-requested", () => {
        void this.confirmNavigation()
          .then((proceed) => invoke("meeting_notes_complete_exit", { proceed }))
          .catch((error: unknown) => this.report(error));
      }),
    );
    this.disposers.push(
      registerOperationGuard({
        matches: (operation) => this.matches(operation),
        confirm: () => this.confirmNavigation(),
      }),
    );
    this.disposers.push(
      await this.ctx.vault.onFileChanged((event) => {
        const session = this.session;
        if (!session || !["delete", "rename"].includes(event.kind)) return;
        const path = event.old_path ?? event.path;
        if (this.pathMatches(path)) {
          void this.cancelRecording()
            .then(() => setUi({ error: mt("targetChanged"), panel: true }))
            .catch((error: unknown) => this.report(error));
        }
      }),
    );
    await invoke("meeting_notes_enable", { enabled: true, detection: meetingUi.detectionEnabled });
    setUi("state", await invoke<MeetingState>("meeting_notes_status"));
    await this.refreshResources();
    await this.discardStaleRecoveries();
  }

  report(error: unknown): void {
    // Technical details may contain model/runtime names; keep the primary UI localised.
    setUi({
      error:
        typeof error === "string" &&
        [mt("documentRequired"), mt("saveFailed"), mt("micDenied"), mt("space")].includes(error)
          ? error
          : mt("error"),
      panel: true,
    });
  }

  async toggle(): Promise<void> {
    if (meetingUi.busy) return;
    if (this.session?.native) {
      if (meetingUi.state.phase === "recording" || this.session.finalized) await this.finish();
      else setUi("panel", true);
      return;
    }
    if (this.session) {
      setUi("setup", true);
      return;
    }
    await this.requestStart(true);
  }

  async requestStart(startWhenReady = false): Promise<void> {
    if (!meetingUi.available) {
      setUi({ panel: true, error: mt("unsupported") });
      return;
    }
    if (this.session || meetingUi.busy) return;
    setUi({ busy: true, error: "", info: "" });
    try {
      const editor = this.ctx.editor.documentSession;
      const host = editor?.getHost?.();
      if (!editor || !host || !host.filePath.toLowerCase().endsWith(".md") || !host.vaultRoot)
        throw mt("documentRequired");
      const saved = await editor.save();
      if (saved.status !== "saved" || this.ctx.editor.documentSession !== editor)
        throw mt("saveFailed");
      const document = this.ctx.editor.retainDocument();
      const id = crypto.randomUUID();
      const target = {
        vaultRoot: document.vaultRoot,
        filePath: document.filePath,
        title: `${mt("title")} · ${new Date().toLocaleString()}`,
      };
      this.session = {
        id,
        target,
        document,
        bridge: new MeetingDocumentBridge(document, id, target.title),
        native: false,
        finalized: false,
      };
      setUi({ target: target.filePath, setup: !startWhenReady, detected: null });
      await this.refreshResources();
      if (!meetingUi.resources?.ready) setUi("setup", true);
    } catch (error) {
      if (this.session && !this.session.native) {
        await this.session.document.release();
        this.session = null;
      }
      setUi({ setup: false, target: "" });
      this.report(error);
    } finally {
      setUi("busy", false);
    }
    if (startWhenReady && this.session && meetingUi.resources?.ready) await this.start();
  }

  async start(): Promise<void> {
    const session = this.session;
    if (!session || session.native || meetingUi.busy) return;
    setUi({ busy: true, error: "", info: "" });
    try {
      if (!meetingUi.resources?.diskSpaceSufficient) throw mt("space");
      if (!meetingUi.resources.ready && !meetingUi.consent) return;
      if (meetingUi.mode !== "system") {
        const permission = await invoke<string>("meeting_notes_request_microphone_permission");
        if (permission !== "authorized") throw mt("micDenied");
      }
      await this.settings?.set("consentVersion", 1);
      await this.settings?.set("mode", meetingUi.mode);
      let capture = this.pendingCapture;
      if (!capture && meetingUi.mode !== "microphone")
        capture = await invoke<MeetingCaptureTarget | null>(
          "meeting_notes_detection_capture_target",
        );
      session.bridge.begin();
      const checkpoint = this.checkpoint(session);
      // This promise also holds autosave until the native journal exists.
      const starting = invoke<MeetingState>("meeting_notes_start", {
        sessionId: session.id,
        target: session.target,
        checkpoint,
        microphoneOnly: meetingUi.mode === "microphone",
        systemOnly: meetingUi.mode === "system",
        captureBundleId: meetingUi.mode === "microphone" ? null : capture?.bundleId,
        captureWindowId: meetingUi.mode === "microphone" ? null : capture?.windowId,
      });
      session.document.beforeSave = async (snapshot) => {
        const savedCheckpoint = this.checkpoint(session, snapshot);
        await starting;
        await invoke("meeting_notes_checkpoint", {
          sessionId: session.id,
          checkpoint: savedCheckpoint,
        });
      };
      const state = await starting;
      session.native = true;
      setUi({ state, setup: false, panel: false });
      if (session.finalPayload) await this.onTranscript(session.finalPayload);
    } catch (error) {
      this.report(error);
      if (!session.native) {
        session.document.beforeSave = undefined;
        session.bridge.unlock();
        await session.document.release();
        this.session = null;
        setUi("setup", false);
      }
    } finally {
      setUi("busy", false);
      this.pendingCapture = null;
    }
  }

  private checkpoint(session: Session, snapshot?: DocumentSnapshot): DocumentCheckpoint {
    const state = snapshot?.state ?? session.document.getState();
    const range = getMeetingPluginState(state);
    const doc = state.doc.toJSON();
    const markdown = getMarkdownService();
    if (!markdown) throw mt("documentRequired");
    return {
      doc,
      content: snapshot?.content ?? markdown.stringify(doc),
      expectedChecksum: snapshot?.checksum ?? session.document.getChecksum(),
      from: range?.from ?? 0,
      to: range?.to ?? 0,
      finalized: session.finalized,
    };
  }

  // IPC events can be lost during a view transition. The durable journal is
  // authoritative, and polling also catches a lost native state event.
  private async reconcile(): Promise<void> {
    const session = this.session;
    if (!session?.native || session.finalized || this.reconciling || this.disposed) return;
    this.reconciling = true;
    try {
      await session.document.checkpoint();
      const state = await invoke<MeetingState>("meeting_notes_status");
      if (this.session !== session || session.finalized) return;
      if (state.sessionId === session.id) setUi("state", state);
      if (state.phase === "error") {
        await this.discardErroredSession(session, state);
        return;
      }
      const entries = await invoke<MeetingJournal[]>("meeting_notes_recoveries");
      const entry = entries.find((candidate) => candidate.sessionId === session.id);
      if (entry?.transcript && this.session === session && !session.finalized)
        await this.onTranscript(entry.transcript);
    } finally {
      this.reconciling = false;
    }
  }

  private async onTranscript(payload: Transcript): Promise<void> {
    const session = this.session;
    if (!session || session.cancelling || payload.sessionId !== session.id || this.disposed) return;
    if (payload.kind === "final") session.finalPayload = payload;
    if (!session.native) return;
    if (payload.kind === "final" && !hasTranscriptText(payload)) {
      session.emptyFinal = true;
      session.bridge.abort();
      session.finalized = true;
      await this.persistFinal(session);
      return;
    }
    if (!session.bridge.apply(payload)) return;
    if (payload.kind === "final") {
      session.finalized = true;
      await this.persistFinal(session);
    }
  }

  private persistFinal(session: Session): Promise<boolean> {
    if (session.saving) return session.saving;
    session.saving = this.saveFinal(session).finally(() => {
      session.saving = undefined;
    });
    return session.saving;
  }

  private async saveFinal(session: Session): Promise<boolean> {
    setUi("state", "phase", "saving");
    const saved = await session.document.save();
    if (saved.status !== "saved") {
      session.resolveFinish?.(false);
      const state: MeetingState = {
        ...meetingUi.state,
        phase: "error",
        errorCode: "save_failed",
        message: mt("saveFailed"),
      };
      queueMicrotask(() => void this.discardErroredSession(session, state, mt("saveFailed")));
      return false;
    }
    try {
      await invoke("meeting_notes_ack", { sessionId: session.id });
      session.document.beforeSave = undefined;
      session.bridge.unlock();
      await session.document.release();
      if (this.session === session) this.session = null;
      setUi({
        state: { ...IDLE_MEETING },
        error: "",
        info: session.emptyFinal
          ? ""
          : mt(session.finalPayload?.speakerLimitWarning ? "speakerWarning" : "saved"),
        target: "",
      });
      session.resolveFinish?.(true);
      return true;
    } catch (error) {
      try {
        await invoke("meeting_notes_cancel", { sessionId: session.id, discard: true });
        session.document.beforeSave = undefined;
        session.bridge.unlock();
        await session.document.release();
        if (this.session === session) this.session = null;
        setUi({
          state: { ...IDLE_MEETING },
          error: "",
          info: session.emptyFinal ? "" : mt("saved"),
          target: "",
        });
        session.resolveFinish?.(true);
        return true;
      } catch {
        this.report(error);
        session.resolveFinish?.(false);
        return false;
      }
    }
  }

  async finish(): Promise<boolean> {
    const session = this.session;
    if (!session) return true;
    if (!session.native) {
      await this.cancelSetup();
      return true;
    }
    if (session.finalized) return this.persistFinal(session);
    if (meetingUi.state.phase === "error") {
      setUi("panel", true);
      return false;
    }
    if (["preparing", "downloading"].includes(meetingUi.state.phase)) {
      await this.cancelRecording();
      return true;
    }
    if (session.finish) return session.finish;
    session.finish = new Promise<boolean>((resolve) => {
      session.resolveFinish = resolve;
    });
    try {
      if (meetingUi.state.phase !== "finalizing" && meetingUi.state.phase !== "saving") {
        await invoke("meeting_notes_stop", { sessionId: session.id });
      }
    } catch (error) {
      this.report(error);
      session.resolveFinish?.(false);
    }
    return session.finish;
  }

  async cancelSetup(): Promise<void> {
    if (meetingUi.busy) return;
    if (this.session && !this.session.native) {
      await this.session.document.release();
      this.session = null;
    }
    setUi({ setup: false, target: "" });
  }

  private matches(operation: GuardedOperation): boolean {
    if (!this.session) return false;
    if (operation.kind === "close-tab") return operation.tabId === this.session.document.tabId;
    if (operation.kind === "change-path") return this.pathMatches(operation.path);
    return true;
  }

  private pathMatches(path: string): boolean {
    const target = this.session?.target.filePath.toLowerCase();
    const normalized = path.replaceAll("\\", "/").toLowerCase().replace(/\/$/u, "");
    return Boolean(target && (target === normalized || target.startsWith(`${normalized}/`)));
  }

  private async confirmNavigation(): Promise<boolean> {
    if (!this.session) return true;
    if (this.guardResolve || meetingUi.busy) return false;
    setUi("guard", true);
    const confirmed = await new Promise<boolean>((resolve) => {
      this.guardResolve = resolve;
    });
    if (!confirmed) return false;
    return this.finish();
  }

  answerGuard(proceed: boolean): void {
    setUi("guard", false);
    this.guardResolve?.(proceed);
    this.guardResolve = undefined;
  }

  async cancelRecording(): Promise<void> {
    const session = this.session;
    if (!session) return;
    if (session.cancelling) return session.cancelling;
    // Finish/ACK may already be removing this session's native files. Do not
    // race it with cancellation or checkpointing a journal it has just removed.
    if (session.saving) {
      await session.saving;
      if (this.session !== session) return;
    }
    if (session.cancelling) return session.cancelling;
    session.cancelling = this.cancelSession(session).finally(() => {
      session.cancelling = undefined;
    });
    return session.cancelling;
  }

  private async cancelSession(session: Session): Promise<void> {
    if (session.native) {
      await invoke("meeting_notes_cancel", { sessionId: session.id, discard: true });
    }
    session.document.beforeSave = undefined;
    session.bridge.abort();
    await session.document.save();
    await session.document.release();
    session.resolveFinish?.(false);
    this.session = null;
    setUi({
      state: { ...IDLE_MEETING },
      setup: false,
      error: "",
      info: "",
      panel: false,
      target: "",
    });
  }

  private async discardErroredSession(
    session: Session,
    state: MeetingState,
    message = mt("error"),
  ): Promise<void> {
    if (session.cancelling) return session.cancelling;
    session.resolveFinish?.(false);
    session.cancelling = this.cancelSession(session)
      .then(() => {
        if (this.disposed) return;
        setUi({ state, error: message, panel: true, info: "" });
      })
      .catch((error: unknown) => this.report(error))
      .finally(() => {
        session.cancelling = undefined;
      });
    return session.cancelling;
  }

  private onDetection(snapshot: MeetingDetectionSnapshot): void {
    if (
      this.disposed ||
      this.detection.observe(snapshot, {
        enabled: meetingUi.detectionEnabled,
        busy: Boolean(this.session) || meetingUi.state.phase !== "idle",
      }) !== "prompt"
    )
      return;
    setUi("detected", snapshot);
    void getCurrentWindow()
      .show()
      .then(() => getCurrentWindow().setFocus())
      .catch(() => {});
  }

  async acceptDetection(): Promise<void> {
    const detection = meetingUi.detected;
    this.pendingCapture = detection?.bundleId
      ? { bundleId: detection.bundleId, windowId: detection.windowId }
      : null;
    setUi("detected", null);
    await this.requestStart(true);
  }

  async setMode(mode: AudioMode): Promise<void> {
    await this.settings?.set("mode", mode);
    setUi("mode", mode);
  }

  async retryWithSystemAudio(): Promise<void> {
    if (meetingUi.busy) return;
    await this.cancelRecording();
    await this.setMode("system");
    setUi({ panel: false, error: "", info: "" });
    await this.requestStart(true);
  }

  async setDetection(enabled: boolean): Promise<void> {
    await this.settings?.set("detection", enabled);
    setUi({ detectionEnabled: enabled, detected: null });
    if (meetingUi.available)
      await invoke("meeting_notes_enable", { enabled: true, detection: enabled });
  }

  async refreshResources(): Promise<void> {
    setUi("resources", await invoke<MeetingResources>("meeting_notes_resources"));
  }
  private async discardStaleRecoveries(): Promise<void> {
    const entries = await invoke<MeetingJournal[]>("meeting_notes_recoveries");
    await Promise.all(
      entries.map((entry) =>
        invoke("meeting_notes_discard_recovery", { sessionId: entry.sessionId }),
      ),
    );
  }

  async removeData(): Promise<void> {
    if (this.session || meetingUi.busy || !window.confirm(mt("removeConfirm"))) return;
    setUi("busy", true);
    try {
      await invoke("meeting_notes_remove_local_data");
      await this.settings?.set("consentVersion", 0);
      setUi({ consent: false, info: mt("removed") });
      await this.refreshResources();
    } catch (error) {
      this.report(error);
    } finally {
      setUi("busy", false);
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.answerGuard(false);
    if (this.session) await this.cancelRecording();
    for (const dispose of this.disposers.splice(0)) dispose();
    if (meetingUi.available)
      await invoke("meeting_notes_enable", { enabled: false, detection: false });
  }
}

let service: MeetingService | null = null;
export function setMeetingService(next: MeetingService | null): void {
  service = next;
}
export function getMeetingService(): MeetingService | null {
  return service;
}
export { meetingUi, setUi as setMeetingUi };
