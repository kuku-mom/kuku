import { Dialog } from "@kobalte/core/dialog";
import { invoke } from "@tauri-apps/api/core";
import { createSignal, onCleanup, onMount, Show, type JSX } from "solid-js";

import type { AudioMode } from "./types";

import { mt } from "./messages";
import { getMeetingService, meetingUi as ui, setMeetingUi as setUi } from "./service";

function run(action: () => Promise<unknown> | undefined): void {
  try {
    void action()?.catch((error: unknown) => getMeetingService()?.report(error));
  } catch (error) {
    getMeetingService()?.report(error);
  }
}

function Button(props: {
  children: JSX.Element;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
}): JSX.Element {
  return (
    <button
      type="button"
      class="meeting-button"
      classList={{ "meeting-primary": props.primary }}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

function MeetingDialog(props: {
  open: boolean;
  title: string;
  close: () => void;
  children: JSX.Element;
}): JSX.Element {
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) props.close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay class="meeting-overlay" />
        <div class="meeting-dialog-position">
          <Dialog.Content class="meeting-dialog">
            <div class="meeting-dialog-header">
              <Dialog.Title class="meeting-title">{props.title}</Dialog.Title>
              <button
                type="button"
                class="meeting-close"
                onClick={props.close}
                aria-label={mt("close")}
              >
                ×
              </button>
            </div>
            {props.children}
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog>
  );
}

function bytes(value: number): string {
  return `${(value / 1_000_000_000).toFixed(2)} GB`;
}
function active(): boolean {
  return !["idle", "error"].includes(ui.state.phase);
}

function AudioSource(props: { onChange: (mode: AudioMode) => void }): JSX.Element {
  return (
    <label class="meeting-field">
      {mt("source")}
      <select
        value={ui.mode}
        disabled={ui.busy || active()}
        onChange={(event) => props.onChange(event.currentTarget.value as AudioMode)}
      >
        <option value="combined">{mt("combined")}</option>
        <option value="microphone">{mt("microphone")}</option>
        <option value="system">{mt("system")}</option>
      </select>
    </label>
  );
}

function needsPermission(): boolean {
  return (
    ui.error === mt("micDenied") ||
    ["microphone_permission", "permission_or_capture", "capture_start"].includes(
      ui.state.errorCode ?? "",
    )
  );
}

export function MeetingToolbar(): JSX.Element {
  const [now, setNow] = createSignal(Date.now());
  onMount(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => window.clearInterval(timer));
  });
  const elapsed = () => {
    const seconds = Math.max(0, Math.floor((now() - (ui.state.startedAtMs ?? now())) / 1000));
    return `${Math.floor(seconds / 60)
      .toString()
      .padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
  };
  return (
    <button
      type="button"
      class="meeting-toolbar"
      classList={{ "meeting-recording": active() }}
      disabled={!ui.loaded || ui.busy}
      title={ui.available ? mt(active() ? "stop" : "start") : mt("unsupported")}
      aria-label={mt(active() ? "stop" : "start")}
      onClick={() => run(() => getMeetingService()?.toggle())}
    >
      <svg
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.7"
        aria-hidden="true"
      >
        <rect x="9" y="2" width="6" height="12" rx="3" />
        <path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" />
      </svg>
      <Show when={active()}>
        <span>{ui.state.phase === "recording" ? elapsed() : mt(ui.state.phase)}</span>
      </Show>
    </button>
  );
}

export function MeetingStatus(): JSX.Element {
  const label = () => {
    if (ui.error) return mt("error");
    if (active()) return mt(ui.state.phase);
    return ui.info;
  };
  return (
    <Show when={active() || ui.error || ui.info}>
      <button type="button" class="meeting-status" onClick={() => setUi("panel", true)}>
        {label()}
        <Show
          when={ui.state.progress !== null && active()}
        >{` · ${Math.round((ui.state.progress ?? 0) * 100)}%`}</Show>
      </button>
    </Show>
  );
}

export function MeetingSettings(): JSX.Element {
  return (
    <div class="meeting-settings">
      <h3 class="meeting-title">{mt("name")}</h3>
      <p>{mt("description")}</p>
      <Show when={!ui.available}>
        <p>{mt("unsupported")}</p>
      </Show>
      <label class="meeting-option">
        <input
          type="checkbox"
          checked={ui.detectionEnabled}
          disabled={!ui.available}
          onChange={(event) =>
            run(() => getMeetingService()?.setDetection(event.currentTarget.checked))
          }
        />
        {mt("detection")}
      </label>
      <p class="meeting-muted">{mt("detectionDescription")}</p>
      <AudioSource onChange={(mode) => run(() => getMeetingService()?.setMode(mode))} />
      <p>{mt("privacy")}</p>
      <Show when={ui.resources}>
        {(resources) => (
          <p>
            {resources().ready
              ? mt("ready")
              : `${mt("download")} ${bytes(resources().estimatedDownloadBytes)}`}
          </p>
        )}
      </Show>
      <div class="meeting-actions">
        <Button
          disabled={active() || ui.setup || ui.busy}
          onClick={() => run(() => getMeetingService()?.removeData())}
        >
          {mt("remove")}
        </Button>
      </div>
    </div>
  );
}

export function MeetingOverlays(): JSX.Element {
  return (
    <>
      <MeetingDialog
        open={ui.setup}
        title={mt("setup")}
        close={() => run(() => getMeetingService()?.cancelSetup())}
      >
        <p class="meeting-destination">{ui.target}</p>
        <AudioSource onChange={(mode) => setUi("mode", mode)} />
        <p>{mt("privacy")}</p>
        <Show when={ui.resources && !ui.resources.ready}>
          <p>
            {mt("download")} <strong>{bytes(ui.resources?.estimatedDownloadBytes ?? 0)}</strong>
          </p>
          <p class="meeting-muted">
            {mt("installedSize")}: {bytes(ui.resources?.estimatedInstalledBytes ?? 0)}
            <Show when={ui.resources?.availableDiskBytes != null}>
              {" "}
              · {mt("availableSpace")}: {bytes(ui.resources?.availableDiskBytes ?? 0)}
            </Show>
          </p>
        </Show>
        <Show when={ui.resources && !ui.resources.diskSpaceSufficient}>
          <p role="alert">{mt("space")}</p>
        </Show>
        <Show when={ui.error}>
          <p role="alert">{ui.error}</p>
          <Show when={needsPermission()}>
            <Button onClick={() => run(() => invoke("meeting_notes_open_microphone_settings"))}>
              {mt("systemSettings")}
            </Button>
          </Show>
        </Show>
        <div class="meeting-actions meeting-actions-end">
          <Button disabled={ui.busy} onClick={() => run(() => getMeetingService()?.cancelSetup())}>
            {mt("cancel")}
          </Button>
          <Button
            primary
            disabled={ui.busy || !ui.resources?.diskSpaceSufficient}
            onClick={() => {
              setUi("consent", true);
              run(() => getMeetingService()?.start());
            }}
          >
            {ui.busy ? mt("preparing") : mt(ui.resources?.ready ? "start" : "downloadStart")}
          </Button>
        </div>
      </MeetingDialog>
      <MeetingDialog
        open={Boolean(ui.detected) && !ui.setup && !ui.guard}
        title={mt("detected")}
        close={() => setUi("detected", null)}
      >
        <p>{ui.detected?.appName}</p>
        <p>{mt("detectedBody")}</p>
        <div class="meeting-actions meeting-actions-end">
          <Button onClick={() => setUi("detected", null)}>{mt("dismiss")}</Button>
          <Button primary onClick={() => run(() => getMeetingService()?.acceptDetection())}>
            {mt("setup")}
          </Button>
        </div>
      </MeetingDialog>
      <MeetingDialog
        open={ui.guard}
        title={mt("guard")}
        close={() => getMeetingService()?.answerGuard(false)}
      >
        <p>{mt("guardBody")}</p>
        <p class="meeting-destination">{ui.target}</p>
        <div class="meeting-actions meeting-actions-end">
          <Button onClick={() => getMeetingService()?.answerGuard(false)}>{mt("stay")}</Button>
          <Button primary onClick={() => getMeetingService()?.answerGuard(true)}>
            {mt("stop")}
          </Button>
        </div>
      </MeetingDialog>
      <MeetingDialog
        open={ui.panel && !ui.setup && !ui.guard && !ui.detected}
        title={mt("name")}
        close={() => setUi("panel", false)}
      >
        <Show when={!ui.available}>
          <p>{mt("unsupported")}</p>
        </Show>
        <Show when={ui.error}>
          <p role="alert">{ui.error}</p>
          <Show when={ui.state.errorCode === "microphone_unavailable"}>
            <p>{mt("micUnavailable")}</p>
          </Show>
        </Show>
        <Show when={ui.error && ui.state.message}>
          <details>
            <summary>{mt("technicalDetails")}</summary>
            <p>
              {ui.state.errorCode}: {ui.state.message}
            </p>
          </details>
        </Show>
        <Show when={ui.info}>
          <p role="status">{ui.info}</p>
        </Show>
        <Show when={active()}>
          <p>
            {mt(ui.state.phase)}{" "}
            <Show when={ui.state.progress !== null}>
              {Math.round((ui.state.progress ?? 0) * 100)}%
            </Show>
          </p>
          <p class="meeting-destination">{ui.target}</p>
        </Show>
        <div class="meeting-actions">
          <Show when={ui.state.phase === "recording" || ui.state.phase === "saving"}>
            <Button primary onClick={() => run(() => getMeetingService()?.finish())}>
              {mt(ui.state.phase === "saving" ? "retry" : "stop")}
            </Button>
          </Show>
          <Show when={active()}>
            <Button onClick={() => run(() => getMeetingService()?.cancelRecording())}>
              {mt("cancelRecording")}
            </Button>
          </Show>
          <Show when={ui.state.errorCode === "microphone_unavailable"}>
            <Button primary onClick={() => run(() => getMeetingService()?.retryWithSystemAudio())}>
              {mt("startSystem")}
            </Button>
          </Show>
          <Show when={ui.error && ui.available && needsPermission()}>
            <Button
              onClick={() =>
                run(() => invoke("meeting_notes_open_settings", { errorCode: ui.state.errorCode }))
              }
            >
              {mt("systemSettings")}
            </Button>
          </Show>
        </div>
      </MeetingDialog>
    </>
  );
}
