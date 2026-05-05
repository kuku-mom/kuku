import { ErrorBoundary, lazy, onCleanup, Show, Suspense } from "solid-js";
import { Dynamic } from "solid-js/web";

import RightPanelTabBar from "~/components/layout/right_panel_tab_bar";
import { t } from "~/i18n";
import { createFocusZone } from "~/plugins/focus_zone";
import { pluginsReady } from "~/plugins/bootstrap";
import { PluginErrorUI, PluginSkeleton, getRightPanelFill } from "~/plugins/slots";
import { layoutState } from "~/stores/layout";

// ── Component ──

const GraphPanelFallback = lazy(() => import("~/plugins/builtin/graph_view/graph_panel"));
const ChatPanelFallback = lazy(() => import("~/plugins/builtin/ai_chat/chat_panel"));
const GBrainPanelFallback = lazy(() => import("~/plugins/third_party/gbrain_panel"));
const LlmWikiPanelFallback = lazy(() => import("~/plugins/third_party/llmwiki_panel"));

export default function RightPanel() {
  const activeRightPanelViewId = () => layoutState.activeRightPanelViewId ?? "ai-chat.panel";
  const activeFill = () => {
    const viewId = activeRightPanelViewId();
    if (viewId === "graph-view.panel") {
      return {
        id: viewId,
        pluginId: "graph-view",
        component: GraphPanelFallback,
      };
    }
    if (viewId === "ai-chat.panel") {
      return {
        id: viewId,
        pluginId: "ai-chat",
        component: ChatPanelFallback,
      };
    }
    if (viewId === "gbrain.panel") {
      return {
        id: viewId,
        pluginId: "gbrain",
        component: GBrainPanelFallback,
      };
    }
    if (viewId === "llmwiki.panel") {
      return {
        id: viewId,
        pluginId: "llmwiki",
        component: LlmWikiPanelFallback,
      };
    }
    const fill = getRightPanelFill(viewId);
    if (fill) return fill;
    return null;
  };

  return (
    <aside
      ref={(el) => onCleanup(createFocusZone(el, "right"))}
      class="flex h-full shrink-0 flex-col overflow-hidden border-l border-border bg-bg-secondary"
      style={{ width: `${layoutState.rightPanelWidth}px` }}
    >
      <RightPanelTabBar />
      <Show when={pluginsReady()} fallback={<PluginSkeleton />}>
        <Show
          when={activeFill()}
          keyed
          fallback={
            <div class="flex h-full items-center justify-center">
              <p class="text-xs text-text-muted">{t("right_panel.no_active_view")}</p>
            </div>
          }
        >
          {(fill) => (
            <ErrorBoundary
              fallback={(err: Error, reset: () => void) => (
                <PluginErrorUI pluginId={fill.pluginId} error={err} onReset={reset} />
              )}
            >
              <Suspense fallback={<PluginSkeleton />}>
                <Dynamic component={fill.component} />
              </Suspense>
            </ErrorBoundary>
          )}
        </Show>
      </Show>
    </aside>
  );
}
