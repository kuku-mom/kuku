// Based on lucide/file, lucide/x, lucide/check, lucide/plus, lucide/ellipsis-vertical,
// lucide/search, lucide/settings, lucide/sparkles, lucide/eye, lucide/eye-off,
// lucide/message-square, lucide/square-arrow-out-up-right
// GraphIcon from kuku-oss (custom node-graph icon)

interface IconProps {
  size?: number;
  class?: string;
}

export function FileIcon(props: IconProps) {
  return (
    <svg
      aria-hidden="true"
      width={props.size ?? 14}
      height={props.size ?? 14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      class={props.class}
    >
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
    </svg>
  );
}

export function ChevronIcon(props: IconProps) {
  return (
    <svg
      aria-hidden="true"
      width={props.size ?? 14}
      height={props.size ?? 14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      class={props.class}
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <svg
      aria-hidden="true"
      width={props.size ?? 10}
      height={props.size ?? 10}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      class={props.class}
    >
      <path d="M18 6 6 18" />
      <path d="M6 6l12 12" />
    </svg>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <svg
      aria-hidden="true"
      width={props.size ?? 12}
      height={props.size ?? 12}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2.2"
      stroke-linecap="round"
      stroke-linejoin="round"
      class={props.class}
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <svg
      aria-hidden="true"
      width={props.size ?? 12}
      height={props.size ?? 12}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      class={props.class}
    >
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </svg>
  );
}

export function OpenInTabIcon(props: IconProps) {
  return (
    <svg
      aria-hidden="true"
      width={props.size ?? 14}
      height={props.size ?? 14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      class={props.class}
    >
      <path d="M21 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6" />
      <path d="M21 3h-6" />
      <path d="M21 3v6" />
      <path d="m10 14 11-11" />
    </svg>
  );
}

export function FolderIcon(props: IconProps) {
  return (
    <svg
      aria-hidden="true"
      width={props.size ?? 14}
      height={props.size ?? 14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      class={props.class}
    >
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}

export function FolderPlusIcon(props: IconProps) {
  return (
    <svg
      aria-hidden="true"
      width={props.size ?? 14}
      height={props.size ?? 14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      class={props.class}
    >
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
      <line x1="12" y1="11" x2="12" y2="17" />
      <line x1="9" y1="14" x2="15" y2="14" />
    </svg>
  );
}

export function EllipsisVerticalIcon(props: IconProps) {
  return (
    <svg
      aria-hidden="true"
      width={props.size ?? 14}
      height={props.size ?? 14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      class={props.class}
    >
      <circle cx="12" cy="12" r="1" />
      <circle cx="12" cy="5" r="1" />
      <circle cx="12" cy="19" r="1" />
    </svg>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <svg
      aria-hidden="true"
      width={props.size ?? 14}
      height={props.size ?? 14}
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
    </svg>
  );
}

export function SettingsIcon(props: IconProps) {
  return (
    <svg
      aria-hidden="true"
      width={props.size ?? 16}
      height={props.size ?? 16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      class={props.class}
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

export function GraphIcon(props: IconProps) {
  return (
    <svg
      aria-hidden="true"
      width={props.size ?? 16}
      height={props.size ?? 16}
      viewBox="0 0 24 24"
      fill="currentColor"
      class={props.class}
    >
      <path d="M3.5 12c.015 0 .028-.004.042-.004l.94 4.226a2.497 2.497 0 1 0 3.345 3.173l7.182 1.197a2.491 2.491 0 1 0 3.527-2.36l1.902-8.238c.021 0 .04.006.062.006a2.5 2.5 0 1 0-2.03-3.95l-4.53-2.012a2.5 2.5 0 1 0-4.692.528L5.151 7.637A2.495 2.495 0 1 0 3.5 12zm1.018-.222a2.51 2.51 0 0 0 1.26-1.26l4.226.94c0 .014-.004.027-.004.042a2.484 2.484 0 0 0 .416 1.377l-3.54 3.54A2.483 2.483 0 0 0 5.5 16c-.014 0-.028.004-.042.004zm7.184-2.635a2.501 2.501 0 0 0-1.48 1.339l-4.226-.94c0-.014.004-.027.004-.042a2.472 2.472 0 0 0-.247-1.065l4.096-3.072a2.477 2.477 0 0 0 1.457.617zM14 11v1a1 1 0 0 1-1 1h-1a1 1 0 0 1-1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1zm1.173 8.605L7.99 18.408a2.483 2.483 0 0 0-.407-1.285l3.54-3.54a2.405 2.405 0 0 0 2.123.29l2.632 4.74a2.494 2.494 0 0 0-.706.992zM6 20H5a1 1 0 0 1-1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1a1 1 0 0 1-1 1zm13 0v1a1 1 0 0 1-1 1h-1a1 1 0 0 1-1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1zm-1.438-1.994c-.02 0-.04-.006-.062-.006a2.466 2.466 0 0 0-.747.127l-2.632-4.74a2.411 2.411 0 0 0 .784-2.53l3.638-1.82a2.502 2.502 0 0 0 .92.731zM20 6h1a1 1 0 0 1 1 1v1a1 1 0 0 1-1 1h-1a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1zm-1.939.963a2.301 2.301 0 0 0 .034 1.18l-3.638 1.82a2.483 2.483 0 0 0-1.763-.943l-.396-3.163a2.499 2.499 0 0 0 1.231-.908zM10 4V3a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1a1 1 0 0 1-1 1h-1a1 1 0 0 1-1-1zM2 9a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" />
    </svg>
  );
}

export function EyeIcon(props: IconProps) {
  return (
    <svg
      aria-hidden="true"
      width={props.size ?? 16}
      height={props.size ?? 16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      class={props.class}
    >
      <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

export function EyeOffIcon(props: IconProps) {
  return (
    <svg
      aria-hidden="true"
      width={props.size ?? 16}
      height={props.size ?? 16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      class={props.class}
    >
      <path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49" />
      <path d="M14.084 14.158a3 3 0 0 1-4.242-4.242" />
      <path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143" />
      <path d="m2 2 20 20" />
    </svg>
  );
}

/** Outlined chat bubble — used e.g. for the right-panel AI Chat tab. */
export function MessageSquareIcon(props: IconProps) {
  return (
    <svg
      aria-hidden="true"
      width={props.size ?? 16}
      height={props.size ?? 16}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width=".8"
      stroke-linecap="round"
      stroke-linejoin="round"
      class={props.class}
    >
      <path d="M14 10a1.333 1.333 0 0 1-1.333 1.333h-8L2 14V3.333A1.333 1.333 0 0 1 3.333 2h9.334A1.333 1.333 0 0 1 14 3.333z" />
    </svg>
  );
}

export function KukuIcon(props: IconProps) {
  return (
    <svg
      aria-hidden="true"
      width={props.size ?? 16}
      height={props.size ?? 16}
      viewBox="0 0 26 26"
      fill="none"
      class={props.class}
    >
      <g
        clip-path="url(#kuku-clip)"
        stroke="currentColor"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        {/* Body */}
        <path
          d="M4.522 1.145c.894-.054 1.924.088 2.98.305 1.06.217 2.187.517 3.27.796 1.091.281 2.14.54 3.078.688a32 32 0 0 0 2.58.283c.776.06 1.508.105 2.178.197 1.367.188 2.556.575 3.657 1.699 2.165 2.208 2.366 5.654 1.973 8.556-.414 3.055-1.942 4.362-3.905 6.47-.965 1.037-1.884 2.16-2.874 3.017-1.013.877-2.16 1.536-3.647 1.655-2.895.232-5.862-1.379-7.7-3.614-.97-1.178-1.18-2.189-1.25-3.346-.07-1.137-.01-2.35-.39-4.146-.186-.883-.529-1.885-.923-2.944-.389-1.045-.832-2.157-1.19-3.203-.36-1.047-.652-2.08-.735-2.996-.083-.91.034-1.798.605-2.458.566-.653 1.4-.906 2.293-.96"
          stroke-width=".8"
        />
        {/* Left eye */}
        <circle cx="7.75" cy="8.75" r="2.97" stroke-width=".65" />
        {/* Right eye */}
        <circle cx="12.27" cy="10.12" r="2.97" stroke-width=".65" />
        {/* Pupils — small filled dots, no stroke */}
        <circle cx="7.2" cy="8.75" r=".95" fill="currentColor" stroke="none" />
        <circle cx="11.7" cy="10.12" r=".95" fill="currentColor" stroke="none" />
        {/* Mouth */}
        <path
          d="m11.453 14.64-3.64-.459a.983.983 0 1 0-.245 1.952l3.639.458a.983.983 0 1 0 .246-1.951"
          stroke-width=".8"
        />
      </g>
      <defs>
        <clipPath id="kuku-clip">
          <path fill="#fff" d="M0 0h26v26H0z" />
        </clipPath>
      </defs>
    </svg>
  );
}
