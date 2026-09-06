import { Show } from "solid-js";

import { SettingsIcon } from "~/components/icons/general_icons";

export type PlannerGlyphName =
  | "search"
  | "alert"
  | "refresh"
  | "plus"
  | "close"
  | "chevron-left"
  | "chevron-right"
  | "chevron-down"
  | "chevron-up"
  | "more"
  | "open"
  | "clock"
  | "settings"
  | "filter"
  | "check"
  | "return"
  | "calendar";

// The same 24px, rounded outline vocabulary as Kuku's general/editor icons.
const paths: Record<PlannerGlyphName, string> = {
  search: "m21 21-5-5m2-6a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
  alert:
    "M12 9v4m0 4h.01M10.3 4.9 2.2 18.7A1.5 1.5 0 0 0 3.5 21h17a1.5 1.5 0 0 0 1.3-2.3L13.7 4.9a2 2 0 0 0-3.4 0Z",
  refresh: "M20 11a8 8 0 0 0-14.4-4.8L3 9m0-6v6h6m-5 4a8 8 0 0 0 14.4 4.8L21 15m0 6v-6h-6",
  plus: "M5 12h14M12 5v14",
  close: "m18 6-12 12M6 6l12 12",
  "chevron-left": "m15 18-6-6 6-6",
  "chevron-right": "m9 18 6-6-6-6",
  "chevron-down": "m6 9 6 6 6-6",
  "chevron-up": "m6 15 6-6 6 6",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  open: "M21 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6M21 3h-6m6 0v6M10 14 21 3",
  clock: "M12 8v4l3 2m6-2a9 9 0 1 1-18 0 9 9 0 0 1 18 0",
  settings: "",
  filter: "M4 7h16M7 12h10M10 17h4",
  check: "m5 12 4 4L19 6",
  return: "M19 5v8H5m5-5-5 5 5 5",
  calendar:
    "M7 3v4m10-4v4M3 10h18M8 15l2 2 5-5M6 5h12a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3Z",
};

export function PlannerGlyph(props: { name: PlannerGlyphName; size?: number; class?: string }) {
  const className = () => `planner-glyph${props.class ? ` ${props.class}` : ""}`;
  return (
    <Show
      when={props.name === "settings"}
      fallback={
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
          class={className()}
        >
          <path d={paths[props.name]} />
        </svg>
      }
    >
      <SettingsIcon size={props.size ?? 14} class={className()} />
    </Show>
  );
}
