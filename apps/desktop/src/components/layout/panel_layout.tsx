import { type JSX, Show } from "solid-js";

import { PanelLeftIcon } from "~/components/icons";
import BottomPanel from "~/components/layout/bottom_panel";
import CenterPanel from "~/components/layout/center_panel";
import LeftPanel from "~/components/layout/left_panel";
import ResizeHandle from "~/components/layout/resize_handle";
import RightPanel from "~/components/layout/right_panel";
import { t } from "~/i18n";
import {
  closeLeftPanelPreview,
  layoutState,
  openLeftPanelPreview,
  setBottomPanelHeight,
  setLeftPanelWidth,
  setRightPanelWidth,
  toggleLeftPanel,
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
          getValue={() => layoutState.leftPanelWidth}
          onResize={setLeftPanelWidth}
        />
      </Show>
      <Show when={!layoutState.leftPanelOpen}>
        <div
          class="relative z-20 flex h-full w-10 shrink-0 flex-col items-center border-r border-border bg-bg-secondary"
          onMouseEnter={openLeftPanelPreview}
          onMouseLeave={closeLeftPanelPreview}
          onFocusIn={openLeftPanelPreview}
          onFocusOut={(event) => {
            const next = event.relatedTarget;
            if (next instanceof Node && event.currentTarget.contains(next)) return;
            closeLeftPanelPreview();
          }}
        >
          <button
            type="button"
            class="mt-2 flex size-7 items-center justify-center rounded-md text-icon-muted transition hover:bg-ghost-hover hover:text-icon"
            title={t("app.action.toggle_left_panel")}
            aria-label={t("app.action.toggle_left_panel")}
            onClick={toggleLeftPanel}
          >
            <PanelLeftIcon size={15} />
          </button>

          <Show when={layoutState.leftPanelPreviewOpen}>
            <div class="absolute top-0 bottom-0 left-0 z-30 shadow-lg">
              <LeftPanel>{props.left}</LeftPanel>
            </div>
          </Show>
        </div>
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
          getValue={() => layoutState.rightPanelWidth}
          onResize={setRightPanelWidth}
          reverse
        />
        <RightPanel />
      </Show>
    </div>
  );
}
