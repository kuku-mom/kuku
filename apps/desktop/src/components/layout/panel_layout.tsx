import { type JSX, Show } from "solid-js";

import BottomPanel from "~/components/layout/bottom_panel";
import CenterPanel from "~/components/layout/center_panel";
import LeftPanel from "~/components/layout/left_panel";
import ResizeHandle from "~/components/layout/resize_handle";
import RightPanel from "~/components/layout/right_panel";
import {
  clearActiveSideResize,
  clearHoveredSideResize,
  isLeftPanelResizeHovered,
  isLeftPanelResizing,
  isRightPanelResizeHovered,
  isRightPanelResizing,
  layoutState,
  setActiveSideResize,
  setHoveredSideResize,
  setBottomPanelHeight,
  setLeftPanelWidth,
  setRightPanelWidth,
} from "~/stores/layout";

// ── Types ──

interface PanelLayoutProps {
  left?: JSX.Element;
  bottom?: JSX.Element;
}

// ── Component ──

/**
 * Four-panel resizable layout (left / center / right / bottom).
 *
 * Panels are conditionally rendered based on `layoutState` and
 * separated by draggable resize handles.
 *
 * ```
 * ┌──────┬────────────────┬──────┐
 * │      │                │      │
 * │ left │     center     │right │
 * │      │                │      │
 * │      ├────────────────┤      │
 * │      │     bottom     │      │
 * ├──────┴────────────────┴──────┘
 * ```
 */
export default function PanelLayout(props: PanelLayoutProps) {
  return (
    <div class="relative flex min-h-0 flex-1 overflow-hidden">
      {/* ── Left panel ── */}
      <Show when={layoutState.leftPanelOpen}>
        <LeftPanel>{props.left}</LeftPanel>
        <ResizeHandle
          direction="col"
          active={isLeftPanelResizing()}
          hovered={isLeftPanelResizeHovered()}
          getValue={() => layoutState.leftPanelWidth}
          onResize={setLeftPanelWidth}
          onResizeStart={() => setActiveSideResize("left")}
          onResizeEnd={clearActiveSideResize}
          onResizeHoverStart={() => setHoveredSideResize("left")}
          onResizeHoverEnd={clearHoveredSideResize}
        />
      </Show>

      {/* ── Center + Bottom column ── */}
      <div class="flex min-h-0 min-w-0 flex-1 flex-col">
        <CenterPanel />

        <Show when={layoutState.bottomPanelOpen}>
          <ResizeHandle
            direction="row"
            getValue={() => layoutState.bottomPanelHeight}
            onResize={setBottomPanelHeight}
            reverse
          />
          <BottomPanel>{props.bottom}</BottomPanel>
        </Show>
      </div>

      {/* ── Right panel ── */}
      <Show when={layoutState.rightPanelOpen}>
        <ResizeHandle
          direction="col"
          active={isRightPanelResizing()}
          hovered={isRightPanelResizeHovered()}
          getValue={() => layoutState.rightPanelWidth}
          onResize={setRightPanelWidth}
          onResizeStart={() => setActiveSideResize("right")}
          onResizeEnd={clearActiveSideResize}
          onResizeHoverStart={() => setHoveredSideResize("right")}
          onResizeHoverEnd={clearHoveredSideResize}
          reverse
        />
        <RightPanel />
      </Show>
    </div>
  );
}
