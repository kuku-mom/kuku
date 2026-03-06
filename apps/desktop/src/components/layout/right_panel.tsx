import type { JSX } from "solid-js";

import { layoutState } from "~/stores/layout";

// ── Types ──

interface RightPanelProps {
  children?: JSX.Element;
}

// ── Component ──

export default function RightPanel(props: RightPanelProps) {
  return (
    <aside
      class="border-border bg-bg-secondary flex h-full shrink-0 flex-col overflow-hidden border-l"
      style={{ width: `${layoutState.rightPanelWidth}px` }}
    >
      {props.children}
    </aside>
  );
}
