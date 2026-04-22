import { debounce } from "@solid-primitives/scheduled";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { batch } from "solid-js";
import { createStore } from "solid-js/store";

// ── Constants ──

const PANEL_MIN = { left: 200, right: 250, bottom: 80 } as const;
const CENTER_MIN_RATIO = { width: 0.45, height: 0.6 } as const;
const CHROME_HEIGHT = 34; // title bar height

/** Center panel must always occupy at least 30% of viewport width. */
function centerMinWidth(): number {
  return Math.floor(window.innerWidth * CENTER_MIN_RATIO.width);
}

/** Center panel must always occupy at least 60% of available height. */
function centerMinHeight(): number {
  return Math.floor((window.innerHeight - CHROME_HEIGHT) * CENTER_MIN_RATIO.height);
}
const STORE_KEY = "layout-state";

/** Track previous window dimensions for proportional resize. */
let prevWindowWidth = window.innerWidth;
let prevWindowHeight = window.innerHeight;

// ── Types ──

interface LayoutState {
  isFullscreen: boolean;

  leftPanelOpen: boolean;
  rightPanelOpen: boolean;
  bottomPanelOpen: boolean;

  leftPanelWidth: number;
  rightPanelWidth: number;
  bottomPanelHeight: number;
  activeRightPanelViewId: string | null;
}

// ── Defaults ──

const DEFAULTS: LayoutState = {
  isFullscreen: false,

  leftPanelOpen: true,
  rightPanelOpen: false,
  bottomPanelOpen: false,

  leftPanelWidth: 280,
  rightPanelWidth: 328,
  bottomPanelHeight: 160,
  activeRightPanelViewId: null,
};

// ── Persistence (localStorage) ──

function loadLayoutSync(): LayoutState {
  const raw = localStorage.getItem(STORE_KEY);
  if (!raw) return { ...DEFAULTS };
  try {
    const saved = JSON.parse(raw) as Partial<LayoutState>;
    return {
      isFullscreen: false,
      leftPanelOpen: saved.leftPanelOpen ?? DEFAULTS.leftPanelOpen,
      rightPanelOpen: saved.rightPanelOpen ?? DEFAULTS.rightPanelOpen,
      bottomPanelOpen: saved.bottomPanelOpen ?? DEFAULTS.bottomPanelOpen,
      leftPanelWidth: Math.min(
        saved.leftPanelWidth ?? DEFAULTS.leftPanelWidth,
        DEFAULTS.leftPanelWidth,
      ),
      rightPanelWidth: Math.min(
        saved.rightPanelWidth ?? DEFAULTS.rightPanelWidth,
        DEFAULTS.rightPanelWidth,
      ),
      bottomPanelHeight: Math.min(
        saved.bottomPanelHeight ?? DEFAULTS.bottomPanelHeight,
        DEFAULTS.bottomPanelHeight,
      ),
      activeRightPanelViewId: saved.activeRightPanelViewId ?? DEFAULTS.activeRightPanelViewId,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveLayoutSync(): void {
  localStorage.setItem(STORE_KEY, JSON.stringify(layoutState));
}

const scheduleSave = debounce(() => saveLayoutSync(), 300);

function saveNow(): void {
  scheduleSave.clear();
  saveLayoutSync();
}

// ── Store ──

const [layoutState, setLayoutState] = createStore<LayoutState>(loadLayoutSync());

// ── Helpers ──

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Pixel overhead from resize handles (1px) + panel borders (1px) per open side panel. */
function horizontalChrome(): number {
  let px = 0;
  if (layoutState.leftPanelOpen) px += 2; // border-r + handle
  if (layoutState.rightPanelOpen) px += 2; // handle + border-l
  return px;
}

/**
 * When both horizontal panels are open, ensure they don't exceed
 * available space. Shrinks the opposing panel first, then the protected one.
 */
function fitHorizontalPanels(protect: "left" | "right"): void {
  if (!layoutState.leftPanelOpen || !layoutState.rightPanelOpen) return;

  const maxForPanels = window.innerWidth - centerMinWidth() - horizontalChrome();
  const overflow = layoutState.leftPanelWidth + layoutState.rightPanelWidth - maxForPanels;

  if (overflow <= 0) return;

  const shrinkKey = protect === "left" ? "rightPanelWidth" : "leftPanelWidth";
  const shrinkMin = protect === "left" ? PANEL_MIN.right : PANEL_MIN.left;
  const shrinkSize = protect === "left" ? layoutState.rightPanelWidth : layoutState.leftPanelWidth;

  const protectKey = protect === "left" ? "leftPanelWidth" : "rightPanelWidth";
  const protectMin = protect === "left" ? PANEL_MIN.left : PANEL_MIN.right;
  const protectSize = protect === "left" ? layoutState.leftPanelWidth : layoutState.rightPanelWidth;

  let remaining = overflow;

  // First: shrink the opposing panel
  const firstShrink = Math.min(remaining, shrinkSize - shrinkMin);
  if (firstShrink > 0) {
    setLayoutState(shrinkKey, shrinkSize - firstShrink);
    remaining -= firstShrink;
  }

  // Then: shrink the protected panel if still overflowing
  if (remaining > 0) {
    setLayoutState(protectKey, Math.max(protectSize - remaining, protectMin));
  }
}

// ── Panel toggles ──

function toggleLeftPanel(): void {
  if (layoutState.leftPanelOpen) {
    setLayoutState("leftPanelOpen", false);
  } else {
    setLayoutState("leftPanelOpen", true);
    fitHorizontalPanels("left");
  }
  saveNow();
}

const DEFAULT_RIGHT_PANEL_VIEW = "graph-view.panel";

function toggleRightPanel(): void {
  if (layoutState.rightPanelOpen) {
    setLayoutState("rightPanelOpen", false);
  } else {
    if (!layoutState.activeRightPanelViewId) {
      setLayoutState("activeRightPanelViewId", DEFAULT_RIGHT_PANEL_VIEW);
    }
    setLayoutState("rightPanelOpen", true);
    fitHorizontalPanels("right");
  }
  saveNow();
}

function openRightPanelView(viewId: string): void {
  setLayoutState("activeRightPanelViewId", viewId);
  if (!layoutState.rightPanelOpen) {
    toggleRightPanel();
    return;
  }
  saveNow();
}

function closeRightPanelView(): void {
  setLayoutState("activeRightPanelViewId", null);
  if (layoutState.rightPanelOpen) {
    toggleRightPanel();
    return;
  }
  saveNow();
}

function setActiveRightPanelView(viewId: string | null): void {
  setLayoutState("activeRightPanelViewId", viewId);
  saveNow();
}

function toggleBottomPanel(): void {
  if (layoutState.bottomPanelOpen) {
    setLayoutState("bottomPanelOpen", false);
  } else {
    setLayoutState("bottomPanelOpen", true);
    const available = window.innerHeight - CHROME_HEIGHT;
    const max = available - centerMinHeight();
    if (layoutState.bottomPanelHeight > max) {
      setLayoutState("bottomPanelHeight", Math.max(max, PANEL_MIN.bottom));
    }
  }
  saveNow();
}

// ── Panel resizers ──

// Resize handlers fire on every mousemove during drag. Wrapping the paired
// panel writes (e.g. adjusting one panel + shrinking its neighbor) in `batch`
// keeps Solid from running two reactive passes per frame, which shows up as
// jitter on the split layout.
function setLeftPanelWidth(width: number): void {
  // Snap-to-close: dragging below half of minimum closes the panel
  if (width < Math.floor(PANEL_MIN.left / 2)) {
    setLayoutState("leftPanelOpen", false);
    scheduleSave();
    return;
  }

  const total = window.innerWidth - horizontalChrome();
  const minCenter = centerMinWidth();

  batch(() => {
    // If expanding left would crush right below its snap threshold, close right
    if (layoutState.rightPanelOpen) {
      const rightWouldBe = total - width - minCenter;
      if (rightWouldBe < Math.floor(PANEL_MIN.right / 2)) {
        setLayoutState("rightPanelOpen", false);
      }
    }

    const rightMin = layoutState.rightPanelOpen ? PANEL_MIN.right : 0;
    const newLeft = clamp(width, PANEL_MIN.left, total - minCenter - rightMin);
    setLayoutState("leftPanelWidth", newLeft);

    // Shrink right panel if it no longer fits
    if (layoutState.rightPanelOpen) {
      const availForRight = total - newLeft - minCenter;
      if (availForRight < layoutState.rightPanelWidth) {
        setLayoutState("rightPanelWidth", Math.max(availForRight, PANEL_MIN.right));
      }
    }
  });
  scheduleSave();
}

function setRightPanelWidth(width: number): void {
  // Snap-to-close
  if (width < Math.floor(PANEL_MIN.right / 2)) {
    setLayoutState("rightPanelOpen", false);
    scheduleSave();
    return;
  }

  const total = window.innerWidth - horizontalChrome();
  const minCenter = centerMinWidth();

  batch(() => {
    // If expanding right would crush left below its snap threshold, close left
    if (layoutState.leftPanelOpen) {
      const leftWouldBe = total - width - minCenter;
      if (leftWouldBe < Math.floor(PANEL_MIN.left / 2)) {
        setLayoutState("leftPanelOpen", false);
      }
    }

    const leftMin = layoutState.leftPanelOpen ? PANEL_MIN.left : 0;
    const newRight = clamp(width, PANEL_MIN.right, total - minCenter - leftMin);
    setLayoutState("rightPanelWidth", newRight);

    // Shrink left panel if it no longer fits
    if (layoutState.leftPanelOpen) {
      const availForLeft = total - newRight - minCenter;
      if (availForLeft < layoutState.leftPanelWidth) {
        setLayoutState("leftPanelWidth", Math.max(availForLeft, PANEL_MIN.left));
      }
    }
  });
  scheduleSave();
}

function setBottomPanelHeight(height: number): void {
  // Snap-to-close
  if (height < Math.floor(PANEL_MIN.bottom / 2)) {
    setLayoutState("bottomPanelOpen", false);
    scheduleSave();
    return;
  }

  const available = window.innerHeight - CHROME_HEIGHT;
  setLayoutState(
    "bottomPanelHeight",
    clamp(height, PANEL_MIN.bottom, available - centerMinHeight()),
  );
  scheduleSave();
}

// ── Proportional resize on window resize ──

function handleWindowResize(): void {
  const newWidth = window.innerWidth;
  const newHeight = window.innerHeight;

  batch(() => {
    // Only scale proportionally when shrinking — growing gives extra space to center
    if (prevWindowWidth > 0 && newWidth < prevWindowWidth) {
      const ratio = newWidth / prevWindowWidth;

      if (layoutState.leftPanelOpen) {
        const scaled = Math.round(layoutState.leftPanelWidth * ratio);
        setLayoutState("leftPanelWidth", Math.max(scaled, PANEL_MIN.left));
      }
      if (layoutState.rightPanelOpen) {
        const scaled = Math.round(layoutState.rightPanelWidth * ratio);
        setLayoutState("rightPanelWidth", Math.max(scaled, PANEL_MIN.right));
      }

      // After scaling, ensure panels still fit
      if (layoutState.leftPanelOpen && layoutState.rightPanelOpen) {
        const chrome = horizontalChrome();
        const minCenter = centerMinWidth();
        const maxForPanels = newWidth - minCenter - chrome;
        const totalPanels = layoutState.leftPanelWidth + layoutState.rightPanelWidth;

        if (totalPanels > maxForPanels) {
          const leftRatio = layoutState.leftPanelWidth / totalPanels;
          setLayoutState(
            "leftPanelWidth",
            Math.max(Math.round(maxForPanels * leftRatio), PANEL_MIN.left),
          );
          setLayoutState(
            "rightPanelWidth",
            Math.max(maxForPanels - layoutState.leftPanelWidth, PANEL_MIN.right),
          );
        }
      }
    }

    if (prevWindowHeight > 0 && newHeight < prevWindowHeight && layoutState.bottomPanelOpen) {
      const ratio = newHeight / prevWindowHeight;
      const scaled = Math.round(layoutState.bottomPanelHeight * ratio);
      const available = newHeight - CHROME_HEIGHT;
      setLayoutState(
        "bottomPanelHeight",
        clamp(scaled, PANEL_MIN.bottom, available - centerMinHeight()),
      );
    }
  });

  prevWindowWidth = newWidth;
  prevWindowHeight = newHeight;
  scheduleSave();
}

// ── Window listeners (fullscreen + resize) ──

let fullscreenUnlisten: (() => void) | undefined;

async function initWindowListeners(): Promise<void> {
  const win = getCurrentWindow();
  setLayoutState("isFullscreen", await win.isFullscreen());

  fullscreenUnlisten = await win.onResized(() => {
    // Proportional panel resize
    handleWindowResize();

    // Fullscreen detection (with delay for transition)
    void (async () => {
      await new Promise((r) => setTimeout(r, 50));
      setLayoutState("isFullscreen", await win.isFullscreen());
    })();
  });
}

function destroyWindowListeners(): void {
  fullscreenUnlisten?.();
  fullscreenUnlisten = undefined;
}

function resetLayoutState(): void {
  setLayoutState({ ...DEFAULTS, isFullscreen: layoutState.isFullscreen });
  saveNow();
}

// ── Exports ──

export {
  closeRightPanelView,
  destroyWindowListeners,
  initWindowListeners,
  layoutState,
  openRightPanelView,
  resetLayoutState,
  setActiveRightPanelView,
  setBottomPanelHeight,
  setLeftPanelWidth,
  setRightPanelWidth,
  toggleBottomPanel,
  toggleLeftPanel,
  toggleRightPanel,
};
