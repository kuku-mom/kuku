import { Popover } from "@kobalte/core/popover";
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";

import { currentLocale } from "~/i18n";

import {
  moveNavigationFocus,
  moveNavigationMonth,
  navigationMonth,
  navigationMonthDays,
  placeDateNavigator,
  validNavigationDate,
} from "./date_navigation";
import { dateFromKey, localDate, weekDays } from "./dates";
import { PlannerGlyph } from "./icons";
import { pt } from "./messages";

import "./date_navigator.css";

export function DateNavigator(props: {
  value: string;
  onChange: (day: string) => void;
  onOpenChange?: (open: boolean) => void;
}) {
  let trigger!: HTMLButtonElement;
  let content: HTMLDivElement | undefined;
  let observer: ResizeObserver | undefined;
  let layoutFrame = 0;
  let focusFrame = 0;
  const [open, setOpen] = createSignal(false);
  const selectedDay = () => (validNavigationDate(props.value) ? props.value : localDate());
  const [month, setMonth] = createSignal(navigationMonth(selectedDay()));
  const [focused, setFocused] = createSignal(selectedDay());
  const [input, setInput] = createSignal(selectedDay());
  const [error, setError] = createSignal(false);
  const [geometry, setGeometry] = createSignal({ left: 0, top: 0, width: 300, maxHeight: 366 });
  const monthLabel = (day: string) =>
    dateFromKey(day).toLocaleDateString(currentLocale(), { year: "numeric", month: "long" });
  const days = createMemo(() => navigationMonthDays(month()));
  const weekdays = () => weekDays("2026-01-05");

  const place = () => {
    if (!trigger?.isConnected) return;
    const pane = trigger.closest(".planner-main")?.getBoundingClientRect();
    setGeometry(
      placeDateNavigator(
        {
          left: Math.max(0, pane?.left ?? 0),
          top: Math.max(0, pane?.top ?? 0),
          right: Math.min(window.innerWidth, pane?.right ?? window.innerWidth),
          bottom: Math.min(window.innerHeight, pane?.bottom ?? window.innerHeight),
        },
        trigger.getBoundingClientRect(),
        (content?.scrollHeight ?? 364) + 2,
      ),
    );
  };
  const schedulePlace = () => {
    cancelAnimationFrame(layoutFrame);
    layoutFrame = requestAnimationFrame(place);
  };
  // Kobalte retains dismissal/focus handling while the virtual anchor keeps the
  // menu inside the actual Planner pane, including when app sidebars resize it.
  const anchorRect = createMemo(() => {
    const position = geometry();
    return () => ({ x: position.left, y: position.top, width: 0, height: 0 });
  });
  const changeOpen = (next: boolean) => {
    if (next === open()) return;
    if (next) {
      setMonth(navigationMonth(selectedDay()));
      setFocused(selectedDay());
      setInput(selectedDay());
      setError(false);
      place();
    } else content = undefined;
    setOpen(next);
    props.onOpenChange?.(next);
  };
  const focusDay = () => {
    cancelAnimationFrame(focusFrame);
    focusFrame = requestAnimationFrame(() => {
      if (open())
        content
          ?.querySelector<HTMLElement>(`[data-date="${focused()}"]`)
          ?.focus({ preventScroll: true });
    });
  };
  const choose = (day: string) => {
    if (!validNavigationDate(day)) {
      setError(true);
      return;
    }
    props.onChange(day);
    changeOpen(false);
  };
  const changeMonth = (direction: -1 | 1) => {
    const next = moveNavigationMonth(focused(), direction);
    if (!next) return;
    setFocused(next);
    setMonth(navigationMonth(next));
  };
  const moveFocus = (event: KeyboardEvent, day: string) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const next = moveNavigationFocus(day, event.key, event.shiftKey);
    if (!next || !validNavigationDate(next)) return;
    event.preventDefault();
    setFocused(next);
    setMonth(navigationMonth(next));
    focusDay();
  };
  createEffect(
    on(open, (expanded) => {
      if (!expanded) return;
      const pane = trigger.closest(".planner-main");
      observer = new ResizeObserver(schedulePlace);
      observer.observe(trigger);
      if (pane) observer.observe(pane);
      if (content) observer.observe(content);
      const scroll = (event: Event) => {
        if (!content?.contains(event.target as Node)) schedulePlace();
      };
      window.addEventListener("resize", schedulePlace);
      window.addEventListener("scroll", scroll, true);
      onCleanup(() => {
        observer?.disconnect();
        observer = undefined;
        cancelAnimationFrame(layoutFrame);
        cancelAnimationFrame(focusFrame);
        window.removeEventListener("resize", schedulePlace);
        window.removeEventListener("scroll", scroll, true);
      });
    }),
  );
  onCleanup(() => {
    cancelAnimationFrame(layoutFrame);
    cancelAnimationFrame(focusFrame);
    if (open()) props.onOpenChange?.(false);
  });

  return (
    <Popover
      open={open()}
      onOpenChange={changeOpen}
      modal={false}
      preventScroll={false}
      placement="bottom-start"
      getAnchorRect={anchorRect()}
      gutter={0}
      flip={false}
      slide={false}
      overflowPadding={0}
    >
      <Popover.Trigger
        ref={trigger}
        class="planner-date-trigger"
        aria-label={`${pt("dateJump")} · ${monthLabel(selectedDay())}`}
        title={pt("dateJump")}
      >
        <span>{monthLabel(selectedDay())}</span>
        <PlannerGlyph name="chevron-down" size={13} />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          ref={(element: HTMLDivElement) => {
            content = element;
            observer?.observe(element);
            schedulePlace();
          }}
          class="planner-date-popup"
          style={{ width: `${geometry().width}px`, "max-height": `${geometry().maxHeight}px` }}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            schedulePlace();
            focusDay();
          }}
        >
          <div class="planner-date-header">
            <button
              type="button"
              aria-label={pt("previousMonth")}
              disabled={!moveNavigationMonth(month(), -1)}
              onClick={() => changeMonth(-1)}
            >
              <PlannerGlyph name="chevron-left" />
            </button>
            <Popover.Title as="span" aria-live="polite">
              {monthLabel(month())}
            </Popover.Title>
            <button
              type="button"
              aria-label={pt("nextMonth")}
              disabled={!moveNavigationMonth(month(), 1)}
              onClick={() => changeMonth(1)}
            >
              <PlannerGlyph name="chevron-right" />
            </button>
          </div>
          <div class="planner-date-grid" role="grid" aria-label={monthLabel(month())}>
            <div class="planner-date-week" role="row">
              <For each={weekdays()}>
                {(day) => (
                  <span
                    role="columnheader"
                    aria-label={dateFromKey(day).toLocaleDateString(currentLocale(), {
                      weekday: "long",
                    })}
                  >
                    {dateFromKey(day).toLocaleDateString(currentLocale(), { weekday: "narrow" })}
                  </span>
                )}
              </For>
            </div>
            <For each={days()}>
              {(week) => (
                <div class="planner-date-week" role="row">
                  <For each={week}>
                    {(day) => (
                      <button
                        type="button"
                        role="gridcell"
                        disabled={!day}
                        data-date={day || undefined}
                        data-outside={navigationMonth(day) !== month() ? "" : undefined}
                        aria-hidden={!day ? "true" : undefined}
                        aria-selected={!!day && day === props.value}
                        aria-current={day === localDate() ? "date" : undefined}
                        aria-label={
                          day
                            ? dateFromKey(day).toLocaleDateString(currentLocale(), {
                                year: "numeric",
                                month: "long",
                                day: "numeric",
                                weekday: "long",
                              })
                            : undefined
                        }
                        tabIndex={day === focused() ? 0 : -1}
                        onFocus={() => setFocused(day)}
                        onKeyDown={(event) => moveFocus(event, day)}
                        onClick={() => choose(day)}
                      >
                        {day ? dateFromKey(day).getDate() : ""}
                      </button>
                    )}
                  </For>
                </div>
              )}
            </For>
          </div>
          <form
            class="planner-date-entry"
            onSubmit={(event) => {
              event.preventDefault();
              choose(input());
            }}
          >
            <label>
              <span>{pt("dateInput")}</span>
              <input
                type="date"
                min="0001-01-01"
                max="9999-12-31"
                value={input()}
                aria-invalid={error() ? "true" : undefined}
                onInput={(event) => {
                  setInput(event.currentTarget.value);
                  setError(false);
                }}
              />
            </label>
            <button type="submit">{pt("goToDate")}</button>
          </form>
          <Show when={error()}>
            <p class="planner-date-error" role="alert">
              {pt("invalidDate")}
            </p>
          </Show>
          <button class="planner-date-today" type="button" onClick={() => choose(localDate())}>
            {pt("today")}
          </button>
        </Popover.Content>
      </Popover.Portal>
    </Popover>
  );
}
