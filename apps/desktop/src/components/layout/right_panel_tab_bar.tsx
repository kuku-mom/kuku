import { type JSX, For } from "solid-js";

import { BrainIcon, GraphIcon, MessageSquareIcon, WikiBookIcon } from "~/components/icons";
import { t } from "~/i18n";
import { layoutState, setActiveRightPanelView } from "~/stores/layout";

// ── Tab definitions ──

interface RightPanelTab {
  viewId: string;
  label: string;
  icon: (size: number) => JSX.Element;
}

function tabs(): RightPanelTab[] {
  return [
    {
      viewId: "graph-view.panel",
      label: t("center.empty.graph_view"),
      icon: (size) => <GraphIcon size={size} />,
    },
    {
      viewId: "ai-chat.panel",
      label: t("right_panel.ai_chat"),
      icon: (size) => <MessageSquareIcon size={size} />,
    },
    {
      viewId: "gbrain.panel",
      label: t("gbrain.title"),
      icon: (size) => <BrainIcon size={size} />,
    },
    {
      viewId: "llmwiki.panel",
      label: t("llmwiki.title"),
      icon: (size) => <WikiBookIcon size={size} />,
    },
  ];
}

export default function RightPanelTabBar() {
  const activeViewId = () => layoutState.activeRightPanelViewId ?? "ai-chat.panel";

  return (
    <div class="shrink-0 border-b border-border">
      <div class="flex h-9.5 items-center justify-between px-2">
        <div class="flex items-center gap-0.5">
          <For each={tabs()}>
            {(tab) => {
              const isActive = () => activeViewId() === tab.viewId;

              return (
                <button
                  type="button"
                  title={tab.label}
                  class={`flex size-7 cursor-pointer items-center justify-center rounded-xs border-none bg-transparent transition-all duration-100 ${
                    isActive()
                      ? "text-icon ring-1 ring-border-focused"
                      : "text-icon-muted hover:bg-ghost-hover hover:text-icon"
                  }`}
                  onClick={() => setActiveRightPanelView(tab.viewId)}
                >
                  {tab.icon(18)}
                </button>
              );
            }}
          </For>
        </div>
      </div>
    </div>
  );
}
