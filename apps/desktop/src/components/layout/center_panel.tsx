import { type JSX, onCleanup, Show } from "solid-js";

import MarkdownEditor from "~/components/editor/markdown_editor";
import ScrollArea from "~/components/scroll_area";
import SettingsView from "~/components/settings/settings_view";
import TabBar from "~/components/layout/tab_bar";
import { pluginsReady } from "~/plugins/bootstrap";
import { createFocusZone } from "~/plugins/focus_zone";
import { filesState, getActiveTab } from "~/stores/files";

// ── Types ──

interface CenterPanelProps {
  children?: JSX.Element;
}

// ── Component ──

export default function CenterPanel(props: CenterPanelProps) {
  const activeTab = () => getActiveTab();
  const editorTab = () => {
    const tab = activeTab();
    if (tab?.type === "editor" && tab.filePath) {
      return tab;
    }
    return null;
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
            <ScrollArea class="h-full" axis="y" alwaysVisible>
              {props.children}
              <div class="flex h-full flex-col items-center justify-center p-6 text-center">
                <p class="text-sm text-text-secondary">Open a vault from the sidebar to start.</p>
                <p class="mt-2 text-xs text-text-muted">
                  The editor will load files here once a vault is open.
                </p>
              </div>
            </ScrollArea>
          </Show>
        </div>
      </Show>
    </div>
  );
}
