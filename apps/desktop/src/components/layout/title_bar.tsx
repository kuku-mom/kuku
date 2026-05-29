import { type JSX, Show } from "solid-js";

import { layoutState } from "~/stores/layout";

// ── No-drag style for interactive regions ──

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
      class={`relative flex h-8.5 shrink-0 items-center bg-bg-secondary px-2 select-none ${props.class ?? ""}`}
      style={
        {
          "-webkit-app-region": "drag",
          "app-region": "drag",
        } as Record<string, string>
      }
      data-tauri-drag-region
    >
      {/* ── macOS traffic-light spacer (hidden in fullscreen) ── */}
      <Show when={!layoutState.isFullscreen}>
        <div class="pointer-events-none w-18 shrink-0" style={NO_DRAG} />
      </Show>

      {/* ── Left region ── */}
      <div class="flex shrink-0 items-center gap-1 px-3" style={NO_DRAG}>
        {props.left}
      </div>

      {/* ── Center region ── */}
      <div class="flex h-full min-w-0 flex-1 items-stretch" style={NO_DRAG}>
        {props.center}
      </div>

      {/* ── Right region ── */}
      <div class="flex shrink-0 items-center gap-1 px-3" style={NO_DRAG}>
        {props.right}
      </div>
    </header>
  );
}
