import { type JSX, onCleanup } from "solid-js";

import { createFocusZone } from "~/plugins/focus_zone";
import { layoutState } from "~/stores/layout";

// ── Types ──

interface RightPanelProps {
  children?: JSX.Element;
}

// ── Component ──

export default function RightPanel(props: RightPanelProps) {
  return (
    <aside
      ref={(el) => onCleanup(createFocusZone(el, "right"))}
      class="flex h-full shrink-0 flex-col overflow-hidden border-l border-border bg-bg-secondary"
      style={{ width: `${layoutState.rightPanelWidth}px` }}
    >
      {props.children}
    </aside>
  );
}
