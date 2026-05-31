import { type JSX, For } from "solid-js";

import {
  GraphIcon,
  KukuIcon,
  MessageSquareIcon,
  SecondBrainIcon,
  VoxelIcon,
} from "~/components/icons";
import { getFills } from "~/plugins/slots";
import { layoutState, setActiveRightPanelView } from "~/stores/layout";

function iconForFill(icon: string | undefined, size: number): JSX.Element {
  if (icon === "graph") return <GraphIcon size={size} />;
  if (icon === "voxel") return <VoxelIcon size={size} />;
  if (icon === "message-square") return <MessageSquareIcon size={size} />;
  if (icon === "second-brain") return <SecondBrainIcon size={size} />;
  return <KukuIcon size={size} />;
}

export default function RightPanelTabBar() {
  const rightPanelFills = () => getFills("rightPanel");

  return (
    <div class="shrink-0 border-b border-border">
      <div class="flex h-9.5 items-center justify-between px-2">
        <div class="flex items-center gap-0.5">
          <For each={rightPanelFills()}>
            {(fill) => {
              const isActive = () => layoutState.activeRightPanelViewId === fill.id;

              return (
                <button
                  type="button"
                  title={fill.label}
                  class={`flex size-7 cursor-pointer items-center justify-center rounded-xs border-none bg-transparent transition-all duration-100 ${
                    isActive()
                      ? "text-icon ring-1 ring-border-focused"
                      : "text-icon-muted hover:bg-ghost-hover hover:text-icon"
                  }`}
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
