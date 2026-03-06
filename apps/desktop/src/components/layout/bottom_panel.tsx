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
      class="flex shrink-0 flex-col overflow-hidden border-t border-border bg-bg-secondary"
      style={{ height: `${layoutState.bottomPanelHeight}px` }}
    >
      {props.children}
    </div>
  );
}
