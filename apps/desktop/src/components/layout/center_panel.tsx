import { type JSX, onCleanup } from "solid-js";

import { createFocusZone } from "~/keybindings";

// ── Types ──

interface CenterPanelProps {
  children?: JSX.Element;
}

// ── Component ──

export default function CenterPanel(props: CenterPanelProps) {
  return (
    <div
      ref={(el) => onCleanup(createFocusZone(el, "center"))}
      class="flex min-w-[30%] flex-1 flex-col overflow-hidden"
    >
      {props.children}
    </div>
  );
}
