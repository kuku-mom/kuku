import { type JSX, For } from "solid-js";

import { GraphIcon, KukuIcon, MessageSquareIcon, SecondBrainIcon } from "~/components/icons";
import { getFills } from "~/plugins/slots";
import { layoutState, setActiveRightPanelView } from "~/stores/layout";

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
      class="relative z-10 flex h-full shrink-0 bg-bg-secondary"
      style={DRAG}
      data-kuku-right-tabbar-drag-track="true"
      data-tauri-drag-region
    >
      <div class="flex h-full items-stretch border-l border-border">
        <div class="flex items-stretch">
          <For each={rightPanelFills()}>
            {(fill) => {
              const isActive = () => layoutState.activeRightPanelViewId === fill.id;

              return (
                <button
                  type="button"
                  data-kuku-right-tab-hit-area="true"
                  title={fill.label}
                  class={`relative flex w-10 shrink-0 cursor-pointer items-center justify-center border-r border-border bg-bg-secondary transition-colors duration-100 ${
                    isActive()
                      ? "z-10 -mb-px bg-white text-icon"
                      : "text-icon-muted hover:bg-bg-tertiary hover:text-icon"
                  }`}
                  style={NO_DRAG}
                  onClick={() => setActiveRightPanelView(fill.id)}
                >
                  {isActive() && (
                    <span class="pointer-events-none absolute inset-x-0 -bottom-px h-px bg-white" />
                  )}
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
