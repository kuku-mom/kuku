import { ErrorBoundary, onCleanup, Show, Suspense } from "solid-js";
import { Dynamic } from "solid-js/web";

import MarkdownEditor from "~/components/editor/markdown_editor";
import SettingsView from "~/components/settings/settings_view";
import TabBar from "~/components/layout/tab_bar";
import { pluginsReady } from "~/plugins/bootstrap";
import { createFocusZone } from "~/plugins/focus_zone";
import { getCenterTabFill, PluginErrorUI, PluginSkeleton } from "~/plugins/slots";
import { filesState, getActiveTab } from "~/stores/files";

// ── Component ──

export default function CenterPanel() {
  const activeTab = () => getActiveTab();
  const pluginTabType = () => activeTab()?.type ?? null;
  const editorTab = () => {
    const tab = activeTab();
    if (tab?.type === "editor" && tab.filePath) {
      return tab;
    }
    return null;
  };
  const pluginFill = () => {
    const tabType = pluginTabType();
    if (!tabType || tabType === "editor" || tabType === "settings") {
      return null;
    }
    return getCenterTabFill(tabType);
  };

  return (
    <div
      ref={(el) => onCleanup(createFocusZone(el, "center"))}
      class="flex min-w-[30%] flex-1 flex-col overflow-hidden bg-bg-primary"
    >
      <TabBar />
      <Show
        when={filesState.tabs.length > 0}
        fallback={
          <div class="flex min-h-0 flex-1 flex-col items-center justify-center">
            <p class="text-sm tracking-wide text-text-muted opacity-50">Focus. Write. Flow.</p>
          </div>
        }
      >
        <div class="min-h-0 flex-1 overflow-hidden">
          <Show when={editorTab()} keyed>
            {(tab) => (
              <Show when={pluginsReady()}>
                <MarkdownEditor tabId={tab.id} filePath={tab.filePath ?? ""} />
              </Show>
            )}
          </Show>
          <Show when={!editorTab() && activeTab()?.type === "settings"}>
            <SettingsView />
          </Show>
          <Show when={!editorTab() && activeTab()?.type !== "settings"}>
            <Show when={pluginsReady()} fallback={<PluginSkeleton />}>
              <Show
                when={pluginFill()}
                keyed
                fallback={
                  <div class="flex h-full flex-col items-center justify-center p-6 text-center">
                    <p class="text-sm text-text-secondary">
                      No view registered for tab type "{pluginTabType()}".
                    </p>
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
          </Show>
        </div>
      </Show>
    </div>
  );
}
