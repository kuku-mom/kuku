import { getCurrentWindow } from "@tauri-apps/api/window";
import { createStore } from "solid-js/store";

// ── Types ──

interface LayoutState {
  isFullscreen: boolean;
}

// ── Store ──

const [layoutState, setLayoutState] = createStore<LayoutState>({
  isFullscreen: false,
});

// ── Fullscreen listener ──

let fullscreenUnlisten: (() => void) | undefined;

async function initFullscreenListener(): Promise<void> {
  const win = getCurrentWindow();
  setLayoutState("isFullscreen", await win.isFullscreen());

  fullscreenUnlisten = await win.onResized(() => {
    void (async () => {
      // Small delay to let the window finish transitioning
      await new Promise((r) => setTimeout(r, 50));
      setLayoutState("isFullscreen", await win.isFullscreen());
    })();
  });
}

function destroyFullscreenListener(): void {
  fullscreenUnlisten?.();
  fullscreenUnlisten = undefined;
}

// ── Exports ──

export { destroyFullscreenListener, initFullscreenListener, layoutState };
