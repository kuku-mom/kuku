import { onCleanup, onMount } from "solid-js";

import { PanelLeftIcon, PanelRightIcon } from "~/components/icons";
import PanelLayout from "~/components/layout/panel_layout";
import TitleBar from "~/components/layout/title_bar";
import {
  destroyFullscreenListener,
  initFullscreenListener,
  layoutState,
  toggleLeftPanel,
  toggleRightPanel,
} from "~/stores/layout";

// ── Styles ──

const ACTION_BTN =
  "flex size-[26px] cursor-pointer items-center justify-center rounded-[6px] border-none bg-transparent text-icon-muted transition-all duration-150 hover:bg-ghost-hover hover:text-icon active:bg-ghost-active [&>svg]:size-3.5";

// ── Component ──

export default function App() {
  onMount(() => {
    void initFullscreenListener();
  });
  onCleanup(() => {
    destroyFullscreenListener();
  });

  return (
    <div class="flex h-screen w-screen flex-col overflow-hidden">
      <TitleBar
        left={
          <button
            type="button"
            class={ACTION_BTN}
            classList={{ "text-text-secondary!": layoutState.leftPanelOpen }}
            onClick={toggleLeftPanel}
            title="Toggle Left Panel"
          >
            <PanelLeftIcon active={layoutState.leftPanelOpen} />
          </button>
        }
        center={<span class="text-xs text-text-muted">CENTER</span>}
        right={
          <button
            type="button"
            class={ACTION_BTN}
            classList={{ "text-text-secondary!": layoutState.rightPanelOpen }}
            onClick={toggleRightPanel}
            title="Toggle Right Panel"
          >
            <PanelRightIcon active={layoutState.rightPanelOpen} />
          </button>
        }
      />
      <PanelLayout
        left={<p class="p-3 text-xs text-text-muted">Left Panel</p>}
        center={
          <div class="flex flex-1 items-center justify-center">
            <p class="text-sm text-text-muted">KUKU</p>
          </div>
        }
        right={<p class="p-3 text-xs text-text-muted">Right Panel</p>}
        bottom={<p class="p-3 text-xs text-text-muted">Bottom Panel</p>}
      />
    </div>
  );
}
