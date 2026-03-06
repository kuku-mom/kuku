import { onCleanup, onMount } from "solid-js";

import TitleBar from "~/components/layout/title_bar";
import { destroyFullscreenListener, initFullscreenListener } from "~/stores/layout";

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
        left={<span class="text-text-muted text-xs">LEFT</span>}
        center={<span class="text-text-muted text-xs">CENTER</span>}
        right={<span class="text-text-muted text-xs">RIGHT</span>}
      />
      <main class="flex min-h-0 flex-1 overflow-hidden">
        <div class="flex flex-1 items-center justify-center">
          <p class="text-text-muted text-sm">KUKU</p>
        </div>
      </main>
    </div>
  );
}
