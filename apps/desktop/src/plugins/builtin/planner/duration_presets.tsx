import { For, createMemo } from "solid-js";

import { currentLocale } from "~/i18n";

import { dateTimeInput, localDateTimeToISO } from "./dates";
import { pt } from "./messages";

export function DurationPresets(props: {
  start: string;
  end: string;
  previousStart?: string;
  previousEnd?: string;
  onEnd: (value: string, iso: string) => void;
  disabled?: boolean;
}) {
  const start = createMemo(() => localDateTimeToISO(props.start, props.previousStart));
  const selected = createMemo(() => {
    const end = localDateTimeToISO(props.end, props.previousEnd);
    return start() && end ? (Date.parse(end) - Date.parse(start()!)) / 60_000 : undefined;
  });
  const label = (minutes: number) =>
    new Intl.NumberFormat(currentLocale(), {
      style: "unit",
      unit: "minute",
      unitDisplay: "short",
    }).format(minutes);
  return (
    <div class="planner-duration-presets" role="group" aria-label={pt("duration")}>
      <span>{pt("duration")}</span>
      <For each={[30, 60, 90]}>
        {(minutes) => (
          <button
            type="button"
            disabled={props.disabled || !start()}
            aria-pressed={selected() === minutes}
            data-selected={selected() === minutes ? "" : undefined}
            onClick={() => {
              const iso = start();
              if (!iso) return;
              const end = new Date(Date.parse(iso) + minutes * 60_000).toISOString();
              props.onEnd(dateTimeInput(end), end);
            }}
          >
            {label(minutes)}
          </button>
        )}
      </For>
    </div>
  );
}
