import type { EventListeners, OverlayScrollbars, PartialOptions } from "overlayscrollbars";

import {
  type OverlayScrollbarsComponentRef,
  OverlayScrollbarsComponent,
} from "overlayscrollbars-solid";
import { type JSX, onCleanup, splitProps } from "solid-js";

// ── Types ──

/** Direction(s) in which the scroll area can scroll. */
type ScrollAxis = "x" | "y" | "both";

/**
 * Controls when the scrollbar automatically hides.
 *
 * - `'never'`  — scrollbar is always visible while content overflows.
 * - `'scroll'` — hides shortly after the user stops scrolling (default).
 * - `'leave'`  — hides when the pointer leaves the scroll area.
 * - `'move'`   — hides when the pointer stops moving inside the area.
 */
type AutoHideMode = "never" | "scroll" | "leave" | "move";

type ScrollAreaProps = Omit<JSX.HTMLAttributes<HTMLDivElement>, "ref"> & {
  children: JSX.Element;

  /**
   * Scrollable axis.
   *
   * - `'y'`    — vertical only (default).
   * - `'x'`    — horizontal only.
   * - `'both'` — both directions.
   */
  axis?: ScrollAxis;

  /**
   * When to auto-hide the scrollbar.
   * Ignored when `alwaysVisible` is `true`.
   * @default 'scroll'
   */
  autoHide?: AutoHideMode;

  /**
   * When `true`, the scrollbar is permanently visible and never auto-hides.
   * The track is rendered with a subtle background for clarity.
   * @default false
   */
  alwaysVisible?: boolean;

  /**
   * Render the track with a fully transparent background.
   * Useful for areas where only the handle should be visible (e.g. tab bars).
   * @default false
   */
  transparentTrack?: boolean;

  /**
   * Convert vertical mouse-wheel events into horizontal scroll.
   * Enables natural scrolling on horizontal-only scroll areas
   * without requiring the user to hold Shift or use a trackpad gesture.
   * @default false
   */
  horizontalWheel?: boolean;

  /**
   * Callback that receives the `OverlayScrollbarsComponentRef`.
   * Use it to access the underlying OverlayScrollbars instance
   * or the root DOM element for programmatic scroll control.
   *
   * @example
   * ```tsx
   * let ref: OverlayScrollbarsComponentRef | undefined;
   * <ScrollArea ref={(r) => (ref = r)}>...</ScrollArea>
   *
   * // Programmatic scroll
   * ref?.osInstance()?.elements().viewport.scrollTop = 200;
   * ```
   */
  ref?: (ref: OverlayScrollbarsComponentRef) => void;

  /**
   * Additional OverlayScrollbars options merged **on top** of the
   * defaults computed from other props.
   * @see https://kingsora.github.io/OverlayScrollbars/#/options
   */
  options?: PartialOptions;

  /**
   * OverlayScrollbars event listeners.
   * The `initialized` event is wrapped internally; if you provide one
   * it will still be called after internal setup completes.
   * @see https://kingsora.github.io/OverlayScrollbars/#/events
   */
  events?: EventListeners;
};

// ── Component ──

/**
 * Custom scroll container with a VSCode / Zed-style square scrollbar.
 *
 * Built on top of {@link https://github.com/KingSora/OverlayScrollbars | OverlayScrollbars}
 * and themed via the `os-theme-kuku` CSS class which reads from the
 * app's design-token CSS variables (`--color-text-muted`, etc.).
 *
 * ### Scrollbar size
 *
 * The scrollbar width/height defaults to **8 px** and can be overridden
 * per-instance with the `--scrollbar-size` CSS custom property:
 *
 * ```tsx
 * <ScrollArea style={{ '--scrollbar-size': '4px' }}>narrow bar</ScrollArea>
 * <ScrollArea style={{ '--scrollbar-size': '12px' }}>wide bar</ScrollArea>
 * ```
 *
 * ### Basic usage
 *
 * ```tsx
 * // Vertical scroll (default)
 * <ScrollArea class="flex-1">{content}</ScrollArea>
 *
 * // Horizontal scroll with wheel support
 * <ScrollArea axis="x" horizontalWheel>{content}</ScrollArea>
 *
 * // Both directions, always visible
 * <ScrollArea axis="both" alwaysVisible>{content}</ScrollArea>
 * ```
 *
 * ### Programmatic scroll control
 *
 * ```tsx
 * let ref: OverlayScrollbarsComponentRef | undefined;
 *
 * <ScrollArea ref={(r) => (ref = r)}>
 *   {content}
 * </ScrollArea>
 *
 * // Later…
 * const viewport = ref?.osInstance()?.elements().viewport;
 * viewport?.scrollTo({ top: 0, behavior: 'smooth' });
 * ```
 */
export default function ScrollArea(props: ScrollAreaProps) {
  const [local, rest] = splitProps(props, [
    "children",
    "axis",
    "autoHide",
    "alwaysVisible",
    "transparentTrack",
    "horizontalWheel",
    "ref",
    "options",
    "events",
  ]);

  let osRef: OverlayScrollbarsComponentRef | undefined;
  let viewportEl: HTMLElement | undefined;

  /** Returns the scrollable viewport element managed by OverlayScrollbars. */
  const getViewport = () => viewportEl ?? osRef?.osInstance()?.elements().viewport;

  // ── Vertical wheel → horizontal scroll ──

  const handleWheel = (e: WheelEvent) => {
    if (!local.horizontalWheel) return;
    const viewport = getViewport();
    if (!viewport || e.deltaX !== 0) return;
    e.preventDefault();
    viewport.scrollLeft += e.deltaY;
  };

  onCleanup(() => {
    const viewport = getViewport();
    if (viewport) {
      viewport.removeEventListener("wheel", handleWheel);
    }
  });

  // ── Stable options ──
  // Computed once to avoid re-creating an object every reactive cycle,
  // which previously caused OverlayScrollbars' MutationObserver to
  // trigger a CPU-bouncing loop.

  const overflowX = local.axis === "y" ? "hidden" : "scroll";
  const overflowY = local.axis === "x" ? "hidden" : "scroll";

  const theme = [
    "os-theme-kuku",
    local.transparentTrack ? "os-theme-kuku-transparent-track" : "",
    local.alwaysVisible ? "os-theme-kuku-visible" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const stableOptions: PartialOptions = {
    overflow: { x: overflowX, y: overflowY },
    scrollbars: {
      theme,
      autoHide: local.alwaysVisible ? "never" : (local.autoHide ?? "scroll"),
      autoHideDelay: 400,
      autoHideSuspend: false,
      dragScroll: true,
      clickScroll: false,
      visibility: local.alwaysVisible ? "visible" : "auto",
    },
    ...local.options,
  };

  // ── Stable events ──

  const userInitialized = local.events?.initialized;

  const stableEvents: EventListeners = {
    ...local.events,
    initialized: (instance: OverlayScrollbars) => {
      viewportEl = instance.elements().viewport;
      if (viewportEl) {
        viewportEl.addEventListener("wheel", handleWheel, { passive: false });
      }
      if (typeof userInitialized === "function") {
        (userInitialized as (instance: OverlayScrollbars) => void)(instance);
      }
    },
  };

  // ── Ref ──

  const setRef = (r: OverlayScrollbarsComponentRef) => {
    osRef = r;
    local.ref?.(r);
  };

  return (
    <OverlayScrollbarsComponent
      ref={setRef}
      options={stableOptions}
      events={stableEvents}
      {...rest}
    >
      {local.children}
    </OverlayScrollbarsComponent>
  );
}
