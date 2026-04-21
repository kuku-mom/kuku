import { Match, Show, Switch } from "solid-js";

import { setDownloading, setReady, updaterState } from "~/stores/updater";

// ── Styling tokens shared across states ──

const PILL_BASE =
  "inline-flex items-center gap-1.5 h-6 px-4 rounded-xs border text-[11px] font-medium tracking-tight cursor-pointer select-none transition-colors duration-150";

// ── Component ──

/**
 * Subtle update affordance for the title bar.
 *
 * Visible states:
 *   - available   → "Update" pill (click to start download)
 *   - downloading → "Downloading N%" pill (non-clickable)
 *   - ready       → "Restart to update" pill (click to relaunch)
 *
 * Hidden when idle / checking to avoid chrome flicker on every launch.
 * `error` surfaces a red pill that the user can click to retry.
 */
async function mockDownload(): Promise<void> {
  for (let p = 0; p <= 100; p += 10) {
    setDownloading(p);
    await new Promise((resolve) => setTimeout(resolve, 140));
  }
  setReady();
}

function handleInstall(): void {
  // TODO(updater-wire): call @tauri-apps/plugin-updater download() here.
  // For now, drive the mocked progress path so the full flow is visible.
  void mockDownload();
}

function handleRestart(): void {
  // TODO(updater-wire): call relaunch() from @tauri-apps/plugin-process.
  // eslint-disable-next-line no-console
  console.info("[updater] restart requested (stub)");
}

function handleRetry(): void {
  // TODO(updater-wire): re-trigger check() here.
  // eslint-disable-next-line no-console
  console.info("[updater] retry requested (stub)");
}

export default function UpdateIndicator() {
  return (
    <Show when={updaterState.status !== "idle" && updaterState.status !== "checking"}>
      <div class="relative flex items-center">
        <Switch>
          <Match when={updaterState.status === "available"}>
            <button
              type="button"
              class={`${PILL_BASE} border-border-variant bg-element text-text-secondary hover:bg-element-hover hover:text-text-primary`}
              onClick={handleInstall}
              title={`Update to ${updaterState.version ?? "latest"}`}
            >
              <DotIndicator tone="info" />
              Update
            </button>
          </Match>

          <Match when={updaterState.status === "downloading"}>
            <span
              class={`${PILL_BASE} cursor-default! border-border-variant bg-element text-text-secondary`}
            >
              <Spinner />
              {Math.round(updaterState.progress)}%
            </span>
          </Match>

          <Match when={updaterState.status === "ready"}>
            <button
              type="button"
              class={`${PILL_BASE} border-info-border bg-info-bg text-info hover:brightness-110`}
              onClick={handleRestart}
              title="Relaunch to finish updating"
            >
              <DotIndicator tone="info" pulse />
              Restart to update
            </button>
          </Match>

          <Match when={updaterState.status === "error"}>
            <button
              type="button"
              class={`${PILL_BASE} border-error-border bg-error-bg text-error hover:brightness-110`}
              onClick={handleRetry}
              title={updaterState.errorMessage ?? "Update check failed"}
            >
              <DotIndicator tone="error" />
              Update failed
            </button>
          </Match>
        </Switch>
      </div>
    </Show>
  );
}

// ── Pieces ──

function DotIndicator(props: { tone: "info" | "error"; pulse?: boolean }) {
  const toneClass = props.tone === "info" ? "bg-info" : "bg-error";
  return (
    <span class="relative inline-flex size-1.5">
      <Show when={props.pulse}>
        <span
          class={`absolute inline-flex size-full animate-ping rounded-full ${toneClass} opacity-60`}
        />
      </Show>
      <span class={`relative inline-flex size-1.5 rounded-full ${toneClass}`} />
    </span>
  );
}

function Spinner() {
  return (
    <svg
      aria-hidden="true"
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      class="animate-spin"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2.5" opacity="0.22" />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        stroke-width="2.5"
        stroke-linecap="round"
      />
    </svg>
  );
}
