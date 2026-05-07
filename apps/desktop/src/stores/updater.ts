import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { createStore } from "solid-js/store";

// ── Types ──

/**
 * UI-facing updater lifecycle.
 *
 *   idle         — no update known; nothing visible
 *   checking     — background check in progress; nothing visible (avoids flicker)
 *   available    — a newer version exists; user can start the download
 *   downloading  — payload streaming; progress available
 *   ready        — payload installed, waiting for app relaunch
 *   error        — last check/download failed; non-blocking
 */
export type UpdaterStatus = "idle" | "checking" | "available" | "downloading" | "ready" | "error";

interface UpdaterState {
  status: UpdaterStatus;
  /** Target version advertised by the update server (e.g. "0.4.2"). */
  version: string | null;
  /** 0–100 while `status === "downloading"`. */
  progress: number;
  /** Most recent error message (set alongside `status: "error"`). */
  errorMessage: string | null;
}

const DEFAULTS: UpdaterState = {
  status: "idle",
  version: null,
  progress: 0,
  errorMessage: null,
};

// ── Store ──

const [updaterState, setUpdaterState] = createStore<UpdaterState>({ ...DEFAULTS });

// Holds the pending `Update` handle between `available` and `downloading` so
// the user's click doesn't have to re-run `check()`.
let pendingUpdate: Update | null = null;

// Byte counters for the active download — Tauri emits chunk deltas, not a
// running total, so we accumulate ourselves.
let downloadedBytes = 0;
let totalBytes = 0;

// ── Internal setters ──

function setStatus(status: UpdaterStatus): void {
  setUpdaterState("status", status);
}

function setAvailable(version: string): void {
  setUpdaterState({ status: "available", version, progress: 0, errorMessage: null });
}

function setDownloading(progress: number): void {
  setUpdaterState({ status: "downloading", progress: Math.max(0, Math.min(100, progress)) });
}

function setReady(): void {
  setUpdaterState({ status: "ready", progress: 100, errorMessage: null });
}

function setError(message: string): void {
  setUpdaterState({ status: "error", errorMessage: message });
}

function reset(): void {
  pendingUpdate = null;
  downloadedBytes = 0;
  totalBytes = 0;
  setUpdaterState({ ...DEFAULTS });
}

// ── Public actions ──

/**
 * Ask the update server whether a newer version exists.
 * Silent: surfaces only `available` (or `error`) — no toast, no dialog.
 */
async function checkForUpdates(): Promise<void> {
  if (updaterState.status === "downloading" || updaterState.status === "ready") return;
  setStatus("checking");
  try {
    const update = await check();
    if (update) {
      pendingUpdate = update;
      setAvailable(update.version);
    } else {
      reset();
    }
  } catch (error) {
    setError(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Download and install the pending update. Drives `downloading` → `ready`.
 * Safe only when `status === "available"`.
 */
async function downloadAndInstall(): Promise<void> {
  const update = pendingUpdate;
  if (!update) {
    setError("No update available");
    return;
  }

  downloadedBytes = 0;
  totalBytes = 0;
  setDownloading(0);

  try {
    await update.downloadAndInstall((event) => {
      switch (event.event) {
        case "Started":
          totalBytes = event.data.contentLength ?? 0;
          downloadedBytes = 0;
          setDownloading(0);
          break;
        case "Progress":
          downloadedBytes += event.data.chunkLength;
          setDownloading(totalBytes > 0 ? (downloadedBytes / totalBytes) * 100 : 0);
          break;
        case "Finished":
          setDownloading(100);
          break;
      }
    });
    setReady();
  } catch (error) {
    setError(error instanceof Error ? error.message : String(error));
  }
}

/** Relaunch to finish applying the update. */
async function restart(): Promise<void> {
  await relaunch();
}

// ── Dev helper ──

/**
 * Dev-only happy-path simulation — drives the store without hitting the
 * update server. Call from the browser console: `window.__kukuUpdater.simulate()`.
 */
async function simulate(): Promise<void> {
  reset();
  setStatus("checking");
  await wait(600);
  setAvailable("0.99.0");
  await wait(1200);
  for (let p = 0; p <= 100; p += 8) {
    setDownloading(p);
    await wait(120);
  }
  setReady();
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (import.meta.env.DEV) {
  const updaterDebugKey = "__kukuUpdater";
  Object.assign(window, {
    [updaterDebugKey]: {
      state: updaterState,
      checkForUpdates,
      downloadAndInstall,
      restart,
      reset,
      simulate,
    },
  });
}

// ── Exports ──

export { checkForUpdates, downloadAndInstall, reset, restart, setError, simulate, updaterState };
