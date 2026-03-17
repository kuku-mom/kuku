import { type JSX, onCleanup } from "solid-js";

import { createFocusZone } from "~/plugins/focus_zone";
import { layoutState } from "~/stores/layout";

// ── Types ──

interface LeftPanelProps {
  children?: JSX.Element;
}

// ── Component ──

export default function LeftPanel(props: LeftPanelProps) {
  return (
    <aside
      ref={(el) => onCleanup(createFocusZone(el, "left"))}
      class="flex h-full shrink-0 flex-col overflow-hidden border-r border-border bg-bg-secondary"
      style={{ width: `${layoutState.leftPanelWidth}px` }}
    >
      {props.children}
    </aside>
  );
}
