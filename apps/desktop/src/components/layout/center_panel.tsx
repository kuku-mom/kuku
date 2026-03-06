import type { JSX } from "solid-js";

// ── Types ──

interface CenterPanelProps {
  children?: JSX.Element;
}

// ── Component ──

export default function CenterPanel(props: CenterPanelProps) {
  return <div class="flex min-w-0 flex-1 flex-col overflow-hidden">{props.children}</div>;
}
