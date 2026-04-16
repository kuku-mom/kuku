import type { OverlayScrollbars, PartialOptions } from "overlayscrollbars";

import { createOverlayScrollbars } from "overlayscrollbars-solid";
import { createMemo, onCleanup, onMount, splitProps, type JSX } from "solid-js";

// ── Public Types ──

/** Direction(s) in which the scroll area can scroll. */
type ScrollAreaAxis = "x" | "y" | "both";

/** Visibility policy for the scrollbar chrome. */
type ScrollbarVisibility = "auto" | "hidden" | "always";

/**
 * Controls when the scrollbar automatically hides.
 *
 * - `'never'`  — scrollbar is always visible while content overflows.
 * - `'scroll'` — hides shortly after the user stops scrolling.
 * - `'leave'`  — hides when the pointer leaves the scroll area.
 * - `'move'`   — hides when the pointer stops moving inside the area.
 */
type ScrollbarAutoHide = "never" | "scroll" | "leave" | "move";

/** Track presentation policy. */
type ScrollbarTrackStyle = "default" | "transparent";

/** High-level reason why a layout-related hook fired. */
type ScrollLayoutReason = "init" | "content" | "resize" | "manual" | "unknown";

interface ScrollPosition {
  top: number;
  left: number;
  height: number;
  width: number;
  scrollHeight: number;
  scrollWidth: number;
}

interface ScrollAreaHandle {
  host: HTMLElement;
  viewport: HTMLElement;
  content: HTMLElement | null;
  scrollTo(options: ScrollToOptions): void;
  scrollBy(options: ScrollToOptions): void;
  getScrollPosition(): ScrollPosition;
  update(): void;
}

type ScrollAreaProps = Omit<JSX.HTMLAttributes<HTMLDivElement>, "ref" | "onScroll"> & {
  children: JSX.Element;

  /**
   * Scrollable axis.
   *
   * - `'y'`    — vertical only (default).
   * - `'x'`    — horizontal only.
   * - `'both'` — both directions.
   */
  axis?: ScrollAreaAxis;

  /**
   * Visibility policy for the scrollbar chrome.
   * - `'auto'`   — show only when scrollable overflow exists.
   * - `'hidden'` — hide the chrome while keeping the area scrollable.
   * - `'always'` — always visible if the backend can support it.
   */
  scrollbarVisibility?: ScrollbarVisibility;

  /**
   * Auto-hide policy for the scrollbar chrome.
   * Note that native backends may interpret this as best-effort.
   */
  scrollbarAutoHide?: ScrollbarAutoHide;

  /**
   * Track style policy.
   * - `'default'`     — standard subtle track.
   * - `'transparent'` — hide track background where possible.
   */
  trackStyle?: ScrollbarTrackStyle;

  /**
   * Convert vertical mouse-wheel events into horizontal scroll.
   * Enables natural scrolling on horizontal-only scroll areas
   * without requiring the user to hold Shift or use a trackpad gesture.
   * @default false
   */
  horizontalWheel?: boolean;

  /**
   * Callback that receives the backend-neutral handle for imperative access.
   */
  handleRef?: (handle: ScrollAreaHandle) => void;

  /**
   * Called once the viewport is ready for imperative access.
   */
  onViewportReady?: (handle: ScrollAreaHandle) => void;

  /**
   * Called after the scroll layout has been updated.
   * This is a best-effort hook and should not be treated as an exact mirror
   * of every backend-internal layout pass.
   */
  onLayout?: (handle: ScrollAreaHandle, reason: ScrollLayoutReason) => void;

  /**
   * Called when the viewport scrolls.
   */
  onScroll?: (event: Event, handle: ScrollAreaHandle) => void;
};

// ── Helpers ──

function resolveLayoutReason(args: {
  force: boolean;
  updateHints: Record<string, boolean>;
}): ScrollLayoutReason {
  if (args.force) return "manual";

  const hints = args.updateHints;
  if (
    hints.sizeChanged ||
    hints.directionChanged ||
    hints.heightIntrinsicChanged ||
    hints.overflowEdgeChanged
  ) {
    return "resize";
  }

  if (
    hints.contentMutation ||
    hints.hostMutation ||
    hints.overflowAmountChanged ||
    hints.overflowStyleChanged ||
    hints.appear
  ) {
    return "content";
  }

  if (hints.scrollCoordinatesChanged) {
    return "manual";
  }

  return "unknown";
}

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function syncScrollbarAxis(
  scrollbar: { scrollbar: HTMLElement; handle: HTMLElement },
  scrollOffset: number,
  scrollSize: number,
  clientSize: number,
): void {
  const maxScroll = Math.max(0, scrollSize - clientSize);
  const scrollPercent = maxScroll > 0 ? clampUnit(scrollOffset / maxScroll) : 0;
  const viewportPercent = scrollSize > 0 ? clampUnit(clientSize / scrollSize) : 1;

  scrollbar.scrollbar.style.setProperty("--os-scroll-percent", `${scrollPercent}`);
  scrollbar.scrollbar.style.setProperty("--os-viewport-percent", `${viewportPercent}`);
  scrollbar.scrollbar.style.setProperty("--os-scroll-direction", "0");
  scrollbar.handle.style.removeProperty("top");
  scrollbar.handle.style.removeProperty("left");
  scrollbar.handle.style.removeProperty("height");
  scrollbar.handle.style.removeProperty("width");
  scrollbar.handle.style.removeProperty("transform");
}

function syncScrollbarVisuals(instance: OverlayScrollbars): void {
  const { viewport, scrollbarHorizontal, scrollbarVertical } = instance.elements();

  syncScrollbarAxis(
    scrollbarVertical,
    viewport.scrollTop,
    viewport.scrollHeight,
    viewport.clientHeight,
  );
  syncScrollbarAxis(
    scrollbarHorizontal,
    viewport.scrollLeft,
    viewport.scrollWidth,
    viewport.clientWidth,
  );
}

// ── Component ──

/**
 * Custom scroll container with a VSCode / Zed-style square scrollbar.
 *
 * The public contract is backend-neutral. The current implementation keeps
 * OverlayScrollbars as the backend while exposing stable DOM hooks and a
 * neutral imperative handle for future migration flexibility.
 */
export default function ScrollArea(props: ScrollAreaProps) {
  const [local, rest] = splitProps(props, [
    "children",
    "axis",
    "scrollbarVisibility",
    "scrollbarAutoHide",
    "trackStyle",
    "horizontalWheel",
    "handleRef",
    "onViewportReady",
    "onLayout",
    "onScroll",
  ]);

  let hostEl: HTMLDivElement | undefined;
  let contentsEl: HTMLDivElement | undefined;
  let pendingScrollbarSyncFrame: number | null = null;

  const getResolvedVisibility = (): ScrollbarVisibility => {
    if (local.scrollbarVisibility) return local.scrollbarVisibility;
    return "auto";
  };

  const getResolvedTrackStyle = (): ScrollbarTrackStyle => local.trackStyle ?? "default";

  const getResolvedAutoHide = (): ScrollbarAutoHide => local.scrollbarAutoHide ?? "scroll";

  const [initialize, osInstance] = createOverlayScrollbars({
    options: createMemo(() => {
      const resolvedVisibility = getResolvedVisibility();
      const resolvedTrackStyle = getResolvedTrackStyle();
      const resolvedAutoHide = getResolvedAutoHide();
      const overflowX = local.axis === "y" ? "hidden" : "scroll";
      const overflowY = local.axis === "x" ? "hidden" : "scroll";
      const visibility = resolvedVisibility === "always" ? "visible" : resolvedVisibility;
      const theme = [
        "os-theme-kuku",
        resolvedTrackStyle === "transparent" ? "os-theme-kuku-transparent-track" : "",
        resolvedVisibility === "always" ? "os-theme-kuku-visible" : "",
      ]
        .filter(Boolean)
        .join(" ");

      return {
        overflow: {
          x: overflowX,
          y: overflowY,
        },
        scrollbars: {
          theme,
          autoHide: visibility === "visible" ? "never" : resolvedAutoHide,
          autoHideDelay: 400,
          autoHideSuspend: false,
          dragScroll: true,
          clickScroll: false,
          visibility,
        },
      } satisfies PartialOptions;
    }),
    events: createMemo(() => ({
      initialized: (instance: OverlayScrollbars) => {
        syncScrollbarVisuals(instance);
        const handle = getHandle();
        if (handle) {
          local.onViewportReady?.(handle);
          local.onLayout?.(handle, "init");
        }
      },
      updated: (instance: OverlayScrollbars, args) => {
        scheduleScrollbarVisualSync(instance);
        const handle = getHandle();
        if (handle) {
          local.onLayout?.(handle, resolveLayoutReason(args));
        }
      },
      scroll: (instance: OverlayScrollbars, event: Event) => {
        scheduleScrollbarVisualSync(instance);
        const handle = getHandle();
        if (handle) {
          local.onScroll?.(event, handle);
        }
      },
      destroyed: () => {
        clearPendingScrollbarSyncFrame();
      },
    })),
  });

  const getViewport = () => contentsEl;

  const getHandle = (): ScrollAreaHandle | undefined => {
    if (!hostEl || !contentsEl) return undefined;

    return {
      host: hostEl,
      viewport: contentsEl,
      content: contentsEl,
      scrollTo: (options) => {
        contentsEl?.scrollTo(options);
      },
      scrollBy: (options) => {
        contentsEl?.scrollBy(options);
      },
      getScrollPosition: () => ({
        top: contentsEl?.scrollTop ?? 0,
        left: contentsEl?.scrollLeft ?? 0,
        height: contentsEl?.clientHeight ?? 0,
        width: contentsEl?.clientWidth ?? 0,
        scrollHeight: contentsEl?.scrollHeight ?? 0,
        scrollWidth: contentsEl?.scrollWidth ?? 0,
      }),
      update: () => {
        osInstance()?.update();
      },
    };
  };

  const clearPendingScrollbarSyncFrame = () => {
    if (pendingScrollbarSyncFrame !== null) {
      cancelAnimationFrame(pendingScrollbarSyncFrame);
      pendingScrollbarSyncFrame = null;
    }
  };

  const scheduleScrollbarVisualSync = (instance = osInstance()) => {
    if (!instance || pendingScrollbarSyncFrame !== null) return;

    pendingScrollbarSyncFrame = requestAnimationFrame(() => {
      pendingScrollbarSyncFrame = null;
      syncScrollbarVisuals(instance);
    });
  };

  const handleWheel = (event: WheelEvent) => {
    if (!local.horizontalWheel) return;
    const viewport = getViewport();
    if (!viewport || event.deltaX !== 0) return;
    event.preventDefault();
    viewport.scrollLeft += event.deltaY;
  };

  onMount(() => {
    if (hostEl && contentsEl) {
      const handle = getHandle();
      if (handle) {
        local.handleRef?.(handle);
      }

      contentsEl.addEventListener("wheel", handleWheel, { passive: false });

      initialize({
        target: hostEl,
        elements: {
          viewport: contentsEl,
          content: contentsEl,
        },
      });
    }
  });

  onCleanup(() => {
    clearPendingScrollbarSyncFrame();
    contentsEl?.removeEventListener("wheel", handleWheel);
  });

  const resolvedAxis = () => local.axis ?? "y";

  return (
    <div
      // Keep the documented initialize marker until the backend changes.
      data-overlayscrollbars-initialize=""
      data-scroll-area=""
      data-scroll-axis={resolvedAxis()}
      data-scrollbar-track={getResolvedTrackStyle()}
      data-scrollbar-visibility={getResolvedVisibility()}
      ref={hostEl}
      {...rest}
    >
      <div data-scroll-area-viewport="" data-scroll-area-content="" ref={contentsEl}>
        {local.children}
      </div>
    </div>
  );
}

export type {
  ScrollAreaAxis,
  ScrollAreaHandle,
  ScrollAreaProps,
  ScrollLayoutReason,
  ScrollPosition,
  ScrollbarAutoHide,
  ScrollbarTrackStyle,
  ScrollbarVisibility,
};
