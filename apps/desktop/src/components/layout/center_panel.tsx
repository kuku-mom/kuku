import { ErrorBoundary, onCleanup, Show, Suspense } from "solid-js";
import { Dynamic } from "solid-js/web";

import MarkdownEditor from "~/components/editor/markdown_editor";
import { KukuLogo } from "~/components/icons/kuku_logo";
import SettingsView from "~/components/settings/settings_view";
import TabBar from "~/components/layout/tab_bar";
import { t } from "~/i18n";
import { pluginsReady } from "~/plugins/bootstrap";
import { createFocusZone } from "~/plugins/focus_zone";
import { getCenterTabFill, PluginErrorUI, PluginSkeleton } from "~/plugins/slots";
import { openSearchOmnibar } from "~/plugins/builtin/search/omnibar_state";
import { filesState, getActiveTab, openSettings, openTab } from "~/stores/files";
import { openRightPanelView, toggleLeftPanel } from "~/stores/layout";
import { createAndOpenNewFile, vaultState } from "~/stores/vault";

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
          <div class="min-h-0 flex-1 overflow-y-hidden">
            <div class="flex min-h-full flex-col items-center justify-center gap-4 p-4">
              <div class="flex aspect-square max-h-[min(16.25rem,25vh)] items-center justify-center">
                <KukuLogo size={260} class="size-full opacity-20 grayscale" />
              </div>
              <p class="text-sm font-normal tracking-wider text-text-muted opacity-60">
                {t("center.empty.tagline")}
              </p>
              <div class="flex w-full max-w-65 flex-col gap-0.5">
                <button
                  type="button"
                  class="flex w-full cursor-pointer items-center justify-between rounded-xs border-none bg-transparent px-3 py-2.5 transition-all duration-150 hover:bg-bg-secondary active:scale-[0.98]"
                  onClick={() => void createAndOpenNewFile()}
                >
                  <span class="text-[0.8125rem] text-text-muted">{t("center.empty.new_file")}</span>
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
                  <span class="text-[0.8125rem] text-text-muted">
                    {t("center.empty.toggle_sidebar")}
                  </span>
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
                  <span class="text-[0.8125rem] text-text-muted">{t("center.empty.settings")}</span>
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
                  <span class="text-[0.8125rem] text-text-muted">
                    {t("center.empty.quick_search")}
                  </span>
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
                  onClick={() => openTab(t("center.empty.advanced_search"), null, "search")}
                >
                  <span class="text-[0.8125rem] text-text-muted">
                    {t("center.empty.advanced_search")}
                  </span>
                  <div class="flex items-center gap-1.5">
                    <kbd class="flex size-7 items-center justify-center rounded-xs border border-border bg-bg-tertiary text-xs text-text-muted">
                      ⌘
                    </kbd>
                    <kbd class="flex size-7 items-center justify-center rounded-xs border border-border bg-bg-tertiary text-xs text-text-muted">
                      U
                    </kbd>
                  </div>
                </button>
                <button
                  type="button"
                  class="flex w-full cursor-pointer items-center justify-between rounded-xs border-none bg-transparent px-3 py-2.5 transition-all duration-150 hover:bg-bg-secondary active:scale-[0.98]"
                  onClick={() => openRightPanelView("graph-view.panel")}
                >
                  <span class="text-[0.8125rem] text-text-muted">
                    {t("center.empty.graph_view")}
                  </span>
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
          </div>
        }
      >
        <div class="min-h-0 flex-1 overflow-hidden">
          <Show when={editorTabKey()} keyed>
            {(_tabKey) => {
              // `id` and `type` are stable for the lifetime of this keyed
              // render (the outer `Show` remounts when they change). Capture
              // them once so we don't read a stale `tab` object reference —
              // `filePath` is read via a reactive getter so rename updates
              // propagate without remounting the editor.
              const tab = editorTab();
              if (!tab) return null;
              const tabId = tab.id;
              const tabType = tab.type;
              return (
                // Wait for the vault to actually be open before mounting the
                // editor — the Rust file-read command errors with
                // "No vault is currently open" otherwise, leaving the
                // restored tab visibly empty on startup until the user
                // re-clicks the tab. pluginsReady + rootPath together mean
                // both the plugin registry and the vault root are ready.
                <Show when={pluginsReady() && vaultState.rootPath}>
                  <MarkdownEditor
                    tabId={tabId}
                    filePath={editorTab()?.filePath ?? ""}
                    mode={tabType === "diff" ? "diff" : "editable"}
                  />
                </Show>
              );
            }}
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
                      {t("center.view.unregistered_prefix")} "{pluginTabType()}"
                      {t("center.view.unregistered_suffix")}
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
