import { type JSX, For } from "solid-js";

import { GraphIcon, KukuIcon, MessageSquareIcon, SecondBrainIcon } from "~/components/icons";
import TitleBarResizeHandle from "~/components/layout/title_bar_resize_handle";
import { getFills } from "~/plugins/slots";
import {
  clearActiveSideResize,
  isRightPanelResizing,
  layoutState,
  setActiveRightPanelView,
  setActiveSideResize,
  setRightPanelWidth,
} from "~/stores/layout";

function iconForFill(icon: string | undefined, size: number): JSX.Element {
  if (icon === "graph") return <GraphIcon size={size} />;
  if (icon === "message-square") return <MessageSquareIcon size={size} />;
  if (icon === "second-brain") return <SecondBrainIcon size={size} />;
  return <KukuIcon size={size} />;
}

const DRAG = {
  "-webkit-app-region": "drag",
  "app-region": "drag",
} as Record<string, string>;

const NO_DRAG = {
  "-webkit-app-region": "no-drag",
  "app-region": "no-drag",
} as Record<string, string>;

export default function RightPanelTabBar() {
  const rightPanelFills = () => getFills("rightPanel");

  return (
    <div
      class="relative z-10 flex h-full min-w-0 flex-1 bg-bg-secondary"
      style={DRAG}
      data-kuku-right-buttonbar-drag-track="true"
      data-tauri-drag-region
    >
      <span
        data-kuku-right-buttonbar-bottom-divider="true"
        class="pointer-events-none absolute inset-x-0 bottom-0 z-0 h-px bg-border"
        aria-hidden="true"
      />
      <TitleBarResizeHandle
        side="right"
        active={isRightPanelResizing()}
        getValue={() => layoutState.rightPanelWidth}
        onResize={setRightPanelWidth}
        onResizeStart={() => setActiveSideResize("right")}
        onResizeEnd={clearActiveSideResize}
        reverse
        data-kuku-titlebar-right-resize-hit-area="true"
      />
      <div
        class="relative z-10 flex h-full items-center border-border px-1"
        classList={{ "border-l": !isRightPanelResizing() }}
      >
        <div class="flex items-center gap-1">
          <For each={rightPanelFills()}>
            {(fill) => {
              const isActive = () => layoutState.activeRightPanelViewId === fill.id;

              return (
                <button
                  type="button"
                  data-kuku-right-panel-button="true"
                  title={fill.label}
                  class={`flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-xs border-none transition-colors duration-100 ${
                    isActive()
                      ? "bg-bg-tertiary text-icon"
                      : "bg-transparent text-icon-muted hover:bg-bg-tertiary hover:text-icon"
                  }`}
                  style={NO_DRAG}
                  onClick={() => setActiveRightPanelView(fill.id)}
                >
                  {iconForFill(fill.icon, 18)}
                </button>
              );
            }}
          </For>
        </div>
      </div>
    </div>
  );
}
