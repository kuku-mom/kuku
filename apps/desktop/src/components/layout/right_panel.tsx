import { ErrorBoundary, onCleanup, Show, Suspense } from "solid-js";
import { Dynamic } from "solid-js/web";

import { t } from "~/i18n";
import { createFocusZone } from "~/plugins/focus_zone";
import { pluginsReady } from "~/plugins/bootstrap";
import { PluginErrorUI, PluginSkeleton, getRightPanelFill } from "~/plugins/slots";
import { layoutState } from "~/stores/layout";

// ── Component ──

export default function RightPanel() {
  const activeRightPanelViewId = () => layoutState.activeRightPanelViewId;
  const activeFill = () => {
    const viewId = activeRightPanelViewId();
    if (!viewId) return null;
    return getRightPanelFill(viewId);
  };

  return (
    <aside
      ref={(el) => onCleanup(createFocusZone(el, "right"))}
      class="flex h-full shrink-0 flex-col overflow-hidden border-l border-border bg-bg-secondary"
      style={{ width: `${layoutState.rightPanelWidth}px` }}
    >
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
