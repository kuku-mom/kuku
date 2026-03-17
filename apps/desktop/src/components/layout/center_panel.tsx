import { type JSX, onCleanup, Show, Switch, Match } from "solid-js";

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
  const activeTabType = () => getActiveTab()?.type ?? null;

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
          <Switch
            fallback={
              <ScrollArea class="h-full" axis="y" alwaysVisible>
                {props.children}
                {/* ── Dummy content for scroll testing ── */}
                <div class="space-y-4 p-6">
                  {Array.from({ length: 50 }, (_, i) => (
                    <div class="rounded-sm border border-border-variant bg-bg-secondary p-4">
                      <p class="text-sm text-text-secondary">
                        Line {i + 1} — Lorem ipsum dolor sit amet, consectetur adipiscing elit.
                      </p>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            }
          >
            <Match when={activeTabType() === "editor" && pluginsReady()}>
              <MarkdownEditor />
            </Match>
            <Match when={activeTabType() === "settings"}>
              <SettingsView />
            </Match>
          </Switch>
        </div>
      </Show>
    </div>
  );
}
