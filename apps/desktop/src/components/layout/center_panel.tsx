import { ErrorBoundary, onCleanup, Show, Suspense } from "solid-js";
import { Dynamic } from "solid-js/web";

import MarkdownEditor from "~/components/editor/markdown_editor";
import { KukuLogo } from "~/components/icons/kuku_logo";
import SettingsView from "~/components/settings/settings_view";
import TabBar from "~/components/layout/tab_bar";
import { pluginsReady } from "~/plugins/bootstrap";
import { createFocusZone } from "~/plugins/focus_zone";
import { getCenterTabFill, PluginErrorUI, PluginSkeleton } from "~/plugins/slots";
import { openSearchOmnibar } from "~/plugins/builtin/search/omnibar_state";
import { filesState, getActiveTab, openSettings } from "~/stores/files";
import { openRightPanelView, toggleLeftPanel } from "~/stores/layout";
import { createAndOpenNewFile } from "~/stores/vault";

// ── Component ──

export default function CenterPanel() {
  const activeTab = () => getActiveTab();
  const pluginTabType = () => activeTab()?.type ?? null;
  const editorTab = () => {
    const tab = activeTab();
    if ((tab?.type === "editor" || tab?.type === "diff") && tab.filePath) {
      return tab;
    }
    return null;
  };
  // Key on id+type only. A tab's `id` is its stable identity; rename or move
  // just updates `filePath` on the same tab, and the document is logically
  // unchanged. Putting filePath in the key would force a remount, discarding
  // the caret via `setEditorDocument(..., "start")`.
  const editorTabKey = () => {
    const tab = editorTab();
    if (!tab) return null;
    return `${tab.id}:${tab.type}`;
  };
  const pluginFill = () => {
    const tabType = pluginTabType();
    if (!tabType || tabType === "editor" || tabType === "diff" || tabType === "settings") {
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
          <div class="flex min-h-0 flex-1 flex-col items-center justify-center gap-12 p-12">
            <KukuLogo size={260} class="opacity-15 grayscale" />
            <p class="-mt-20 text-sm font-normal tracking-wider text-text-muted opacity-50">
              Focus. Write. Flow.
            </p>
            <div class="flex w-full max-w-65 flex-col gap-0.5">
              <button
                type="button"
                class="flex w-full cursor-pointer items-center justify-between rounded-xs border-none bg-transparent px-3 py-2.5 transition-all duration-150 hover:bg-bg-secondary active:scale-[0.98]"
                onClick={() => void createAndOpenNewFile()}
              >
                <span class="text-[0.8125rem] text-text-muted">New File</span>
                <div class="flex items-center gap-1.5">
                  <kbd class="flex size-7 items-center justify-center rounded-xs border border-border bg-bg-tertiary text-xs text-text-muted">
                    ⌘
                  </kbd>
                  <kbd class="flex size-7 items-center justify-center rounded-xs border border-border bg-bg-tertiary text-xs text-text-muted">
                    N
                  </kbd>
                </div>
              </button>
              <button
                type="button"
                class="flex w-full cursor-pointer items-center justify-between rounded-xs border-none bg-transparent px-3 py-2.5 transition-all duration-150 hover:bg-bg-secondary active:scale-[0.98]"
                onClick={() => toggleLeftPanel()}
              >
                <span class="text-[0.8125rem] text-text-muted">Toggle Sidebar</span>
                <div class="flex items-center gap-1.5">
                  <kbd class="flex size-7 items-center justify-center rounded-xs border border-border bg-bg-tertiary text-xs text-text-muted">
                    ⌘
                  </kbd>
                  <kbd class="flex size-7 items-center justify-center rounded-xs border border-border bg-bg-tertiary text-xs text-text-muted">
                    B
                  </kbd>
                </div>
              </button>
              <button
                type="button"
                class="flex w-full cursor-pointer items-center justify-between rounded-xs border-none bg-transparent px-3 py-2.5 transition-all duration-150 hover:bg-bg-secondary active:scale-[0.98]"
                onClick={() => openSettings()}
              >
                <span class="text-[0.8125rem] text-text-muted">Settings</span>
                <div class="flex items-center gap-1.5">
                  <kbd class="flex size-7 items-center justify-center rounded-xs border border-border bg-bg-tertiary text-xs text-text-muted">
                    ⌘
                  </kbd>
                  <kbd class="flex size-7 items-center justify-center rounded-xs border border-border bg-bg-tertiary text-xs text-text-muted">
                    ,
                  </kbd>
                </div>
              </button>
              <button
                type="button"
                class="flex w-full cursor-pointer items-center justify-between rounded-xs border-none bg-transparent px-3 py-2.5 transition-all duration-150 hover:bg-bg-secondary active:scale-[0.98]"
                onClick={() => openSearchOmnibar()}
              >
                <span class="text-[0.8125rem] text-text-muted">Quick Search</span>
                <div class="flex items-center gap-1.5">
                  <kbd class="flex size-7 items-center justify-center rounded-xs border border-border bg-bg-tertiary text-xs text-text-muted">
                    ⌘
                  </kbd>
                  <kbd class="flex size-7 items-center justify-center rounded-xs border border-border bg-bg-tertiary text-xs text-text-muted">
                    P
                  </kbd>
                </div>
              </button>
              <button
                type="button"
                class="flex w-full cursor-pointer items-center justify-between rounded-xs border-none bg-transparent px-3 py-2.5 transition-all duration-150 hover:bg-bg-secondary active:scale-[0.98]"
                onClick={() => openRightPanelView("graph-view.panel")}
              >
                <span class="text-[0.8125rem] text-text-muted">Graph View</span>
                <div class="flex items-center gap-1.5">
                  <kbd class="flex size-7 items-center justify-center rounded-xs border border-border bg-bg-tertiary text-xs text-text-muted">
                    ⌘
                  </kbd>
                  <kbd class="flex size-7 items-center justify-center rounded-xs border border-border bg-bg-tertiary text-xs text-text-muted">
                    G
                  </kbd>
                </div>
              </button>
            </div>
          </div>
        }
      >
        <div class="min-h-0 flex-1 overflow-hidden">
          <Show when={editorTabKey()} keyed>
            {(_tabKey) => (
              <Show when={editorTab()}>
                {(tab) => (
                  <Show when={pluginsReady()}>
                    <MarkdownEditor
                      tabId={tab().id}
                      filePath={tab().filePath ?? ""}
                      mode={tab().type === "diff" ? "diff" : "editable"}
                    />
                  </Show>
                )}
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
