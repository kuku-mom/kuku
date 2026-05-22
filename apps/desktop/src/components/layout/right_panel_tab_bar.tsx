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

export default function RightPanelTabBar() {
  const rightPanelFills = () => getFills("rightPanel");

  return (
    <div class="relative z-10 shrink-0 bg-bg-secondary">
      <div class="flex h-9.5 items-stretch border-b border-border">
        <div class="flex items-stretch">
          <For each={rightPanelFills()}>
            {(fill) => {
              const isActive = () => layoutState.activeRightPanelViewId === fill.id;

              return (
                <button
                  type="button"
                  title={fill.label}
                  class={`relative flex w-10 shrink-0 cursor-pointer items-center justify-center border-r border-border bg-bg-secondary transition-colors duration-100 ${
                    isActive()
                      ? "z-10 -mb-px bg-white text-icon"
                      : "text-icon-muted hover:bg-bg-tertiary hover:text-icon"
                  }`}
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
