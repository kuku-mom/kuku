import { localDate } from "./dates";

export function calendarClock(now: Date) {
  return { day: localDate(now), minute: now.getHours() * 60 + now.getMinutes() };
}

export interface CalendarViewport {
  height: number;
  headerHeight: number;
  scrollHeight: number;
}

export function calendarScrollTarget(
  minute: number,
  viewport: CalendarViewport,
  pixelsPerMinute: number,
) {
  const visibleTimeHeight = Math.max(0, viewport.height - viewport.headerHeight);
  return Math.max(
    0,
    Math.min(
      Math.max(0, viewport.scrollHeight - viewport.height),
      minute * pixelsPerMinute - visibleTimeHeight / 3,
    ),
  );
}

export function initialCalendarScroll(
  days: readonly string[],
  now: Date,
  savedPosition: number | undefined,
  viewport: CalendarViewport,
  pixelsPerMinute: number,
) {
  if (savedPosition !== undefined && Number.isFinite(savedPosition) && savedPosition >= 0) {
    return Math.min(savedPosition, Math.max(0, viewport.scrollHeight - viewport.height));
  }
  const clock = calendarClock(now);
  return calendarScrollTarget(
    days.includes(clock.day) ? clock.minute : 9 * 60,
    viewport,
    pixelsPerMinute,
  );
}
