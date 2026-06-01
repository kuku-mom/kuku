import { type JSX, Show } from "solid-js";

import { layoutState } from "~/stores/layout";

// ── Window drag styles ──

const DRAG = {
  "-webkit-app-region": "drag",
  "app-region": "drag",
} as Record<string, string>;

const NO_DRAG = {
  "-webkit-app-region": "no-drag",
  "app-region": "no-drag",
} as Record<string, string>;

// ── Types ──

interface TitleBarProps {
  /** Content for the left region (after traffic-light spacer) */
  left?: JSX.Element;
  /** Main inline title-bar content between the left and right regions */
  center?: JSX.Element;
  /** Content for the right region */
  right?: JSX.Element;
  /** Extra CSS classes on the root header */
  class?: string;
}

// ── Component ──

/**
 * Tauri window drag header with three extensible regions (left / center / right).
 *
 * The entire bar is a drag region by default.
 * Each slot automatically opts out of drag so interactive children work.
 *
 * ```tsx
 * <TitleBar
 *   left={<SidebarToggle />}
 *   center={<TabBar />}
 *   right={<SettingsButton />}
 * />
 * ```
 */
export default function TitleBar(props: TitleBarProps) {
  return (
    <header
      class={`relative flex h-8.5 shrink-0 items-center bg-bg-secondary select-none ${props.class ?? ""}`}
      style={DRAG}
      data-tauri-drag-region
    >
      {/* ── Center region ── */}
      <div class="absolute inset-0 z-10 flex h-full min-w-0 items-stretch">
        {props.center}
      </div>

      {/* ── Left region ── */}
      <div
        class="absolute inset-y-0 left-0 z-20 flex items-center px-1"
        style={DRAG}
        data-kuku-titlebar-left-hit-area="true"
        data-tauri-drag-region
      >
        <span
          data-kuku-titlebar-left-bottom-divider="true"
          class="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-border"
          aria-hidden="true"
        />
        {/* macOS traffic-light spacer (hidden in fullscreen) */}
        <Show when={!layoutState.isFullscreen}>
          <div class="pointer-events-none w-18 shrink-0" />
        </Show>
        <div
          class="flex shrink-0 items-center gap-1 px-1"
          style={NO_DRAG}
          data-kuku-titlebar-left-controls="true"
        >
          {props.left}
        </div>
      </div>

      {/* ── Right region ── */}
      <div
        class="absolute inset-y-0 right-0 z-20 flex items-center justify-end px-1"
        style={DRAG}
        data-kuku-titlebar-right-hit-area="true"
        data-tauri-drag-region
      >
        <span
          data-kuku-titlebar-right-bottom-divider="true"
          class="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-border"
          aria-hidden="true"
        />
        <div
          class="flex shrink-0 items-center gap-1 px-1"
          style={NO_DRAG}
          data-kuku-titlebar-right-controls="true"
        >
          {props.right}
        </div>
      </div>
    </header>
  );
}
