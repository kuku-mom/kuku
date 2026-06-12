// Graph-view control icons — based on Lucide icon set.
// See also: general_icons.tsx for shared icons (GraphIcon, SearchIcon, etc.)

interface IconProps {
  size?: number;
  class?: string;
}

export function GraphEmptyIcon(props: IconProps) {
  return (
    <svg
      aria-hidden="true"
      width={props.size ?? 28}
      height={props.size ?? 28}
      viewBox="0 0 24 24"
      fill="currentColor"
      opacity="0.25"
      class={props.class}
    >
      <path d="M3.5 12c.015 0 .028-.004.042-.004l.94 4.226a2.497 2.497 0 1 0 3.345 3.173l7.182 1.197a2.491 2.491 0 1 0 3.527-2.36l1.902-8.238c.021 0 .04.006.062.006a2.5 2.5 0 1 0-2.03-3.95l-4.53-2.012a2.5 2.5 0 1 0-4.692.528L5.151 7.637A2.495 2.495 0 1 0 3.5 12z" />
    </svg>
  );
}

export function ZoomInIcon(props: IconProps) {
  return (
    <svg
      aria-hidden="true"
      width={props.size ?? 13}
      height={props.size ?? 13}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      class={props.class}
    >
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
      <line x1="11" y1="8" x2="11" y2="14" />
      <line x1="8" y1="11" x2="14" y2="11" />
    </svg>
  );
}

export function ZoomOutIcon(props: IconProps) {
  return (
    <svg
      aria-hidden="true"
      width={props.size ?? 13}
      height={props.size ?? 13}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      class={props.class}
    >
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
      <line x1="8" y1="11" x2="14" y2="11" />
    </svg>
  );
}

export function ClustersIcon(props: IconProps) {
  return (
    <svg
      aria-hidden="true"
      width={props.size ?? 13}
      height={props.size ?? 13}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      class={props.class}
    >
      <circle cx="6" cy="6" r="3" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="18" r="3" />
    </svg>
  );
}

export function VoxelIcon(props: IconProps) {
  return (
    <svg
      aria-hidden="true"
      width={props.size ?? 14}
      height={props.size ?? 14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
      class={props.class}
    >
      <path d="M12 2.75 20 7.2v9.6l-8 4.45-8-4.45V7.2z" />
      <path d="M12 12 20 7.2" />
      <path d="M12 12 4 7.2" />
      <path d="M12 12v9.25" />
      <path d="m7.6 9.35 8-4.45" opacity="0.55" />
      <path d="M7.6 14.65 12 17.1l4.4-2.45" opacity="0.55" />
    </svg>
  );
}

export function FitViewIcon(props: IconProps) {
  return (
    <svg
      aria-hidden="true"
      width={props.size ?? 13}
      height={props.size ?? 13}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      class={props.class}
    >
      <path d="M8 3H5a2 2 0 0 0-2 2v3" />
      <path d="M21 8V5a2 2 0 0 0-2-2h-3" />
      <path d="M3 16v3a2 2 0 0 0 2 2h3" />
      <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
    </svg>
  );
}

export function LocateIcon(props: IconProps) {
  return (
    <svg
      aria-hidden="true"
      width={props.size ?? 13}
      height={props.size ?? 13}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      class={props.class}
    >
      <circle cx="12" cy="12" r="8" />
      <path d="M12 2v4" />
      <path d="M12 18v4" />
      <path d="M2 12h4" />
      <path d="M18 12h4" />
    </svg>
  );
}

export function PauseIcon(props: IconProps) {
  return (
    <svg
      aria-hidden="true"
      width={props.size ?? 13}
      height={props.size ?? 13}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      class={props.class}
    >
      <rect x="6" y="4" width="4" height="16" rx="1" />
      <rect x="14" y="4" width="4" height="16" rx="1" />
    </svg>
  );
}

export function PlayIcon(props: IconProps) {
  return (
    <svg
      aria-hidden="true"
      width={props.size ?? 13}
      height={props.size ?? 13}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      class={props.class}
    >
      <path d="M6 4.5 19 12 6 19.5z" />
    </svg>
  );
}

export function ResetViewIcon(props: IconProps) {
  return (
    <svg
      aria-hidden="true"
      width={props.size ?? 13}
      height={props.size ?? 13}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      class={props.class}
    >
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
    </svg>
  );
}
