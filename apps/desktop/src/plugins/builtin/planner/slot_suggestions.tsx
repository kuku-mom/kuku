import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";

import { currentLocale } from "~/i18n";
import type { PlannerTask } from "~/lib/planner_tasks";

import { analyzeOverlap, suggestFreeSlots } from "./availability";
import { planningCalendars, planningExcludedKeys, planningIntervals } from "./availability_context";
import type { CalendarRange } from "./calendar_gestures";
import { addDays, dateFromKey, localDate, localDateTimeToISO } from "./dates";
import { PlannerGlyph } from "./icons";
import { pt } from "./messages";
import { providers } from "./providers";
import type { PlannerService } from "./service";
import type { CalendarChoice, ExternalItem } from "./types";

export function SlotSuggestions(props: {
  service: PlannerService;
  start: string;
  end: string;
  allDay?: boolean;
  previousStart?: string;
  previousEnd?: string;
  exclude?: PlannerTask | ExternalItem;
  destination?: CalendarChoice | null;
  disabled?: boolean;
  onSelect: (range: CalendarRange) => void;
}) {
  const [expanded, setExpanded] = createSignal(false);
  const [revision, setRevision] = createSignal(0);
  const [remote, setRemote] = createSignal<ExternalItem[]>();
  const [status, setStatus] = createSignal<"loading" | "ready" | "error">("loading");
  const [now, setNow] = createSignal(new Date());
  createEffect(() => {
    if (!expanded()) return;
    const timer = setInterval(() => setNow(new Date()), 60_000);
    const focus = () => {
      setNow(new Date());
      setRevision((value) => value + 1);
    };
    window.addEventListener("focus", focus);
    onCleanup(() => {
      clearInterval(timer);
      window.removeEventListener("focus", focus);
    });
  });
  let generation = 0;
  const range = createMemo<CalendarRange | undefined>(() => {
    if (props.allDay) return undefined;
    const start = localDateTimeToISO(props.start, props.previousStart);
    const end = localDateTimeToISO(props.end, props.previousEnd);
    return start && end && Date.parse(end) - Date.parse(start) >= 15 * 60000
      ? { start, end, allDay: false }
      : undefined;
  });
  const day = () => (range() ? localDate(new Date(range()!.start)) : "");
  // Read the chosen day independently of the displayed week. A partially loaded
  // weekly cache must never make a future date appear free. These reads write
  // neither events nor the service's currently displayed week cache.
  const readKey = createMemo(() =>
    JSON.stringify({
      day: day(),
      through: range() ? addDays(localDate(new Date(Date.parse(range()!.end) - 1)), 1) : "",
      calendars: planningCalendars(props.service, props.destination).map((target) => ({
        ...target,
        connected: props.service.state.sources[target.provider].status.connected,
        updatedAt: props.service.state.sources[target.provider].updatedAt,
      })),
      revision: revision(),
    }),
  );
  createEffect(() => {
    const request = JSON.parse(readKey()) as {
      day: string;
      through: string;
      calendars: { provider: "google" | "apple-calendar"; ids: string[]; connected: boolean }[];
    };
    const sequence = ++generation;
    setRemote(undefined);
    if (!request.day) return;
    setNow(new Date());
    if (!request.calendars.length) {
      setRemote([]);
      setStatus("ready");
      return;
    }
    if (request.calendars.some((target) => !target.connected)) {
      setStatus("error");
      return;
    }
    setStatus("loading");
    const first = dateFromKey(request.day).toISOString();
    const last = dateFromKey(request.through).toISOString();
    void Promise.all(
      request.calendars.map(async (target) => {
        const calendars = await providers.calendars(target.provider);
        if (target.ids.some((id) => !calendars.some((calendar) => calendar.id === id)))
          throw new Error("A selected calendar is no longer available.");
        return providers.items(
          target.provider,
          target.ids,
          first,
          last,
          Intl.DateTimeFormat().resolvedOptions().timeZone,
        );
      }),
    )
      .then((pages) => {
        if (sequence !== generation) return;
        setRemote(pages.flat());
        setStatus("ready");
      })
      .catch(() => {
        if (sequence === generation) setStatus("error");
      });
  });
  onCleanup(() => {
    generation++;
  });
  const intervals = createMemo(() => planningIntervals(props.service, remote()));
  const excluded = () => planningExcludedKeys(props.service, props.exclude);
  const overlap = createMemo(() =>
    range()
      ? analyzeOverlap(range()!, intervals(), excluded())
      : { minutes: 0, items: [], allDayItems: [] },
  );
  const duration = () =>
    range() ? (Date.parse(range()!.end) - Date.parse(range()!.start)) / 60000 : 30;
  const slots = createMemo(() =>
    range() && status() === "ready" && expanded()
      ? suggestFreeSlots({
          day: day(),
          durationMinutes: duration(),
          intervals: intervals(),
          excludedKeys: excluded(),
          preferredStart: range()!.start,
          now: now(),
        })
      : [],
  );
  const time = (iso: string) =>
    new Date(iso).toLocaleTimeString(currentLocale(), {
      hour: "2-digit",
      minute: "2-digit",
    });
  return (
    <Show when={range()}>
      <section class="planner-slot-suggestions" aria-label={pt("freeTime")}>
        <Show when={overlap().minutes > 0}>
          <div class="planner-overlap-notice" role="status">
            <PlannerGlyph name="alert" />
            <div>
              <strong>
                {Math.ceil(overlap().minutes)}
                {pt("minutes")} {pt("timeOverlap")}
              </strong>
              <span
                title={overlap()
                  .items.map((item) => item.title)
                  .join(", ")}
              >
                {overlap()
                  .items.map((item) => item.title)
                  .join(", ")}
              </span>
            </div>
          </div>
        </Show>
        <Show when={overlap().allDayItems.length}>
          <p
            class="planner-slot-context"
            title={overlap()
              .allDayItems.map((item) => item.title)
              .join(", ")}
          >
            <PlannerGlyph name="calendar" size={12} />
            {pt("allDay")} ·{" "}
            {overlap()
              .allDayItems.map((item) => item.title)
              .join(", ")}
          </p>
        </Show>
        <button
          type="button"
          class="planner-slot-toggle"
          aria-expanded={expanded()}
          onClick={() => {
            setNow(new Date());
            if (!expanded()) setRevision((value) => value + 1);
            setExpanded(!expanded());
          }}
        >
          <PlannerGlyph name="clock" />
          <span>{pt("freeTime")}</span>
          <PlannerGlyph name={expanded() ? "chevron-up" : "chevron-down"} size={12} />
        </button>
        <Show when={expanded()}>
          <p class="planner-slot-context">
            09:00–18:00 · {Math.round(duration())}
            {pt("minutes")} · {pt("selectedCalendarsOnly")}
            <button
              type="button"
              class="planner-slot-refresh"
              aria-label={pt("refresh")}
              title={pt("refresh")}
              disabled={status() === "loading"}
              onClick={() => setRevision((value) => value + 1)}
            >
              <PlannerGlyph name="refresh" size={12} />
            </button>
          </p>
          <Show
            when={status() === "ready"}
            fallback={
              <div class="planner-slot-status" role="status">
                <span>
                  {status() === "loading"
                    ? pt("checkingAvailability")
                    : pt("availabilityUnavailable")}
                </span>
                <Show when={status() === "error"}>
                  <button
                    type="button"
                    aria-label={pt("refresh")}
                    onClick={() => setRevision((value) => value + 1)}
                  >
                    <PlannerGlyph name="refresh" />
                  </button>
                </Show>
              </div>
            }
          >
            <div class="planner-slot-options">
              <For each={slots()}>
                {(slot) => (
                  <button
                    type="button"
                    disabled={props.disabled}
                    onClick={() => {
                      const current = new Date();
                      setNow(current);
                      if (
                        status() === "ready" &&
                        (day() !== localDate(current) ||
                          Date.parse(slot.start) >= current.getTime())
                      )
                        props.onSelect(slot);
                    }}
                  >
                    <span>
                      {time(slot.start)} – {time(slot.end)}
                    </span>
                    <PlannerGlyph name="chevron-right" size={12} />
                  </button>
                )}
              </For>
            </div>
            <Show when={!slots().length}>
              <p class="planner-slot-context">{pt("noFreeTime")}</p>
            </Show>
          </Show>
        </Show>
      </section>
    </Show>
  );
}
