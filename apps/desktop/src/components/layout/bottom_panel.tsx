import type { JSX } from "solid-js";

import { layoutState } from "~/stores/layout";

// ── Types ──

interface BottomPanelProps {
  children?: JSX.Element;
}

// ── Component ──

export default function BottomPanel(props: BottomPanelProps) {
  return (
    <div
      class="border-border bg-bg-secondary flex shrink-0 flex-col overflow-hidden border-t"
      style={{ height: `${layoutState.bottomPanelHeight}px` }}
    >
      {props.children}
    </div>
  );
}
