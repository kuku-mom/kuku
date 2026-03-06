import { Show } from "solid-js";

interface LayoutIconProps {
  size?: number;
  class?: string;
  active?: boolean;
}

export function PanelLeftIcon(props: LayoutIconProps) {
  return (
    <svg
      aria-hidden="true"
      width={props.size ?? 16}
      height={props.size ?? 16}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      class={props.class}
    >
      <Show when={props.active}>
        <rect x="2" y="3" width="3" height="10" fill="currentColor" opacity="0.35" />
      </Show>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <line x1="5.5" y1="2.5" x2="5.5" y2="13.5" />
    </svg>
  );
}

export function PanelRightIcon(props: LayoutIconProps) {
  return (
    <svg
      aria-hidden="true"
      width={props.size ?? 16}
      height={props.size ?? 16}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      class={props.class}
    >
      <Show when={props.active}>
        <rect x="11" y="3" width="3" height="10" fill="currentColor" opacity="0.35" />
      </Show>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <line x1="10.5" y1="2.5" x2="10.5" y2="13.5" />
    </svg>
  );
}
