import { getCurrentWindow } from "@tauri-apps/api/window";
import { createStore } from "solid-js/store";

// ── Types ──

interface LayoutState {
  isFullscreen: boolean;

  leftPanelOpen: boolean;
  rightPanelOpen: boolean;
  bottomPanelOpen: boolean;

  leftPanelWidth: number;
  rightPanelWidth: number;
  bottomPanelHeight: number;
}

// ── Defaults ──

const DEFAULTS: LayoutState = {
  isFullscreen: false,

  leftPanelOpen: true,
  rightPanelOpen: true,
  bottomPanelOpen: true,

  leftPanelWidth: 240,
  rightPanelWidth: 300,
  bottomPanelHeight: 160,
};

// ── Constraints ──

const MIN_PANEL_WIDTH = 120;
const MAX_PANEL_WIDTH = 600;
const MIN_PANEL_HEIGHT = 80;
const MAX_PANEL_HEIGHT = 400;

function clampWidth(value: number): number {
  return Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, value));
}

function clampHeight(value: number): number {
  return Math.max(MIN_PANEL_HEIGHT, Math.min(MAX_PANEL_HEIGHT, value));
}

// ── Store ──

const [layoutState, setLayoutState] = createStore<LayoutState>({
  ...DEFAULTS,
});

// ── Panel toggles ──

function toggleLeftPanel(): void {
  setLayoutState("leftPanelOpen", (open) => !open);
}

function toggleRightPanel(): void {
  setLayoutState("rightPanelOpen", (open) => !open);
}

function toggleBottomPanel(): void {
  setLayoutState("bottomPanelOpen", (open) => !open);
}

// ── Panel resizers ──

function setLeftPanelWidth(value: number): void {
  setLayoutState("leftPanelWidth", clampWidth(value));
}

function setRightPanelWidth(value: number): void {
  setLayoutState("rightPanelWidth", clampWidth(value));
}

function setBottomPanelHeight(value: number): void {
  setLayoutState("bottomPanelHeight", clampHeight(value));
}

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

export {
  destroyFullscreenListener,
  initFullscreenListener,
  layoutState,
  setBottomPanelHeight,
  setLeftPanelWidth,
  setRightPanelWidth,
  toggleBottomPanel,
  toggleLeftPanel,
  toggleRightPanel,
};
