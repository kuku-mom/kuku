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

// ── Public actions (stubbed; real Tauri wiring lands after UI review) ──

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
  setUpdaterState({ ...DEFAULTS });
}

/**
 * Dev-only helper. Walks the happy path end-to-end so the UI can be eyeballed
 * without a real update server. Call from the browser console:
 *   window.__kukuUpdater.simulate()
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

// Expose handles on `window` in dev so the indicator can be driven by hand.
if (import.meta.env.DEV) {
  // @ts-expect-error — intentional dev-only global
  window.__kukuUpdater = {
    state: updaterState,
    setStatus,
    setAvailable,
    setDownloading,
    setReady,
    setError,
    reset,
    simulate,
  };
}

// ── Exports ──

export {
  reset,
  setAvailable,
  setDownloading,
  setError,
  setReady,
  setStatus,
  simulate,
  updaterState,
};
