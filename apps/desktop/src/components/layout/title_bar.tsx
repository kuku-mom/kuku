import { type JSX, Show } from "solid-js";

import { isMacPlatform } from "~/lib/platform";
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
  /** Content for the center region */
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
 *   center={<SearchInput />}
 *   right={<SettingsButton />}
 * />
 * ```
 */
export default function TitleBar(props: TitleBarProps) {
  return (
    <header
      class={`relative flex h-8.5 shrink-0 items-center border-b border-border bg-bg-secondary px-2 select-none ${props.class ?? ""}`}
      style={
        {
          "-webkit-app-region": "drag",
          "app-region": "drag",
        } as Record<string, string>
      }
      data-tauri-drag-region
    >
      {/* ── macOS traffic-light spacer (hidden in fullscreen) ── */}
      <Show when={isMacPlatform() && !layoutState.isFullscreen}>
        <div class="pointer-events-none w-18 shrink-0" style={NO_DRAG} />
      </Show>

      {/* ── Left region ── */}
      <div class="flex shrink-0 items-center gap-1 px-3" style={NO_DRAG}>
        {props.left}
      </div>

      {/* ── Spacer (pushes right region to the end) ── */}
      <div class="flex-1" />

      {/* ── Center region (absolute for true center) ── */}
      <div
        class="pointer-events-none absolute inset-x-0 flex items-center justify-center"
        style={NO_DRAG}
      >
        <div class="pointer-events-auto">{props.center}</div>
      </div>

      {/* ── Right region ── */}
      <div class="flex shrink-0 items-center gap-1 px-3" style={NO_DRAG}>
        {props.right}
      </div>
    </header>
  );
}
