import type { JSX } from "solid-js";

import { layoutState } from "~/stores/layout";

// ── Types ──

interface LeftPanelProps {
  children?: JSX.Element;
}

// ── Component ──

export default function LeftPanel(props: LeftPanelProps) {
  return (
    <aside
      class="border-border bg-bg-secondary flex h-full shrink-0 flex-col overflow-hidden border-r"
      style={{ width: `${layoutState.leftPanelWidth}px` }}
    >
      {props.children}
    </aside>
  );
}
