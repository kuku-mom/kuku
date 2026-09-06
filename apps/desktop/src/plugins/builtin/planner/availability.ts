import type { CalendarRange } from "./calendar_gestures";
import { addDays, dateFromKey, localDate } from "./dates";

export interface BusyInterval {
  key: string;
  title: string;
  start: string;
  end: string;
  allDay?: boolean;
}
export interface OverlapAnalysis {
  minutes: number;
  items: BusyInterval[];
  /** Informational only: all-day entries do not occupy timed work slots. */
  allDayItems: BusyInterval[];
}
export interface FreeSlotOptions {
  day: string;
  durationMinutes: number;
  intervals: readonly BusyInterval[];
  excludedKeys?: Iterable<string>;
  preferredStart?: string;
  now?: Date;
  startHour?: number;
  endHour?: number;
  limit?: number;
}
interface Span {
  start: number;
  end: number;
}
interface ParsedInterval extends Span {
  item: BusyInterval;
}

const MINUTE = 60_000;
const STEP = 15 * MINUTE;

function validDateKey(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function instant(value: string): number {
  // Timed records must carry a zone; a date-only value is not a UTC time block.
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    ) ||
    !validDateKey(value.slice(0, 10))
  )
    return Number.NaN;
  return Date.parse(value);
}
function span(value: { start: string; end: string; allDay?: boolean }): Span | null {
  const start = value.allDay
    ? dateFromKey(value.start?.slice(0, 10) ?? "").getTime()
    : instant(value.start);
  const end = value.allDay
    ? dateFromKey(value.end?.slice(0, 10) ?? "").getTime()
    : instant(value.end);
  return Number.isFinite(start) && Number.isFinite(end) && end > start ? { start, end } : null;
}
function parsedIntervals(
  intervals: readonly BusyInterval[],
  excludedKeys?: Iterable<string>,
): ParsedInterval[] {
  const excluded = new Set(excludedKeys);
  const seen = new Set<string>();
  return intervals.flatMap((item) => {
    if (!item || typeof item.key !== "string" || excluded.has(item.key)) return [];
    const range = span(item);
    if (!range) return [];
    const identity = JSON.stringify([item.key, range.start, range.end, Boolean(item.allDay)]);
    if (seen.has(identity)) return [];
    seen.add(identity);
    return [{ ...range, item }];
  });
}
function merge(spans: readonly Span[]): Span[] {
  const result: Span[] = [];
  for (const value of [...spans].sort((a, b) => a.start - b.start || a.end - b.end)) {
    const previous = result.at(-1);
    if (previous && value.start <= previous.end) previous.end = Math.max(previous.end, value.end);
    else result.push({ start: value.start, end: value.end });
  }
  return result;
}
function intersects(a: Span, b: Span) {
  return a.start < b.end && a.end > b.start;
}
function uniqueItems(intervals: readonly ParsedInterval[]): BusyInterval[] {
  const found = new Map<string, BusyInterval>();
  for (const interval of intervals)
    if (!found.has(interval.item.key)) found.set(interval.item.key, interval.item);
  return [...found.values()];
}

export function analyzeOverlap(
  range: Pick<CalendarRange, "start" | "end"> & { allDay?: boolean },
  intervals: readonly BusyInterval[],
  excludedKeys?: Iterable<string>,
): OverlapAnalysis {
  const selected = span(range);
  if (!selected) return { minutes: 0, items: [], allDayItems: [] };
  const overlapping = parsedIntervals(intervals, excludedKeys).filter((item) =>
    intersects(selected, item),
  );
  const timed = overlapping.filter(({ item }) => !item.allDay);
  const occupied = merge(
    timed.map((item) => ({
      start: Math.max(item.start, selected.start),
      end: Math.min(item.end, selected.end),
    })),
  );
  return {
    minutes: occupied.reduce((total, item) => total + (item.end - item.start) / MINUTE, 0),
    items: uniqueItems(timed),
    allDayItems: uniqueItems(overlapping.filter(({ item }) => item.allDay)),
  };
}

function workingSpans(
  day: string,
  first: number,
  last: number,
  startMinute: number,
  endMinute: number,
): Span[] {
  const segments: Span[] = [];
  // Walk real instants through the local day. Spring gaps never materialize and
  // both occurrences of a repeated fall hour retain their distinct UTC offsets.
  for (let time = first; time < last; time += STEP) {
    const date = new Date(time);
    const minute = date.getHours() * 60 + date.getMinutes();
    if (localDate(date) !== day || minute % 15 !== 0 || minute < startMinute || minute >= endMinute)
      continue;
    segments.push({ start: time, end: Math.min(last, time + STEP) });
  }
  return merge(segments);
}
function freeSpans(working: readonly Span[], busy: readonly Span[], earliest: number): Span[] {
  const free: Span[] = [];
  for (const window of working) {
    let cursor = Math.max(window.start, earliest);
    for (const interval of busy) {
      if (interval.end <= cursor || interval.start >= window.end) continue;
      if (interval.start > cursor)
        free.push({ start: cursor, end: Math.min(interval.start, window.end) });
      cursor = Math.max(cursor, interval.end);
      if (cursor >= window.end) break;
    }
    if (cursor < window.end) free.push({ start: cursor, end: window.end });
  }
  return free;
}

/** Recommendations only. Callers apply the chosen range through their usual write path. */
export function suggestFreeSlots(options: FreeSlotOptions): CalendarRange[] {
  const first = dateFromKey(options.day).getTime();
  const last = dateFromKey(addDays(options.day, 1)).getTime();
  const startHour = options.startHour ?? 9;
  const endHour = options.endHour ?? 18;
  const limit = options.limit ?? 3;
  const duration = options.durationMinutes * MINUTE;
  const now = options.now ?? new Date();
  if (
    !Number.isFinite(first) ||
    !Number.isFinite(last) ||
    last <= first ||
    !Number.isFinite(duration) ||
    options.durationMinutes < 15 ||
    !Number.isFinite(now.getTime()) ||
    !Number.isInteger(limit) ||
    limit <= 0 ||
    !Number.isFinite(startHour) ||
    !Number.isFinite(endHour) ||
    startHour < 0 ||
    endHour > 24 ||
    startHour >= endHour ||
    !Number.isInteger(startHour * 4) ||
    !Number.isInteger(endHour * 4)
  )
    return [];
  const working = workingSpans(options.day, first, last, startHour * 60, endHour * 60);
  const busy = merge(
    parsedIntervals(options.intervals, options.excludedKeys)
      .filter(({ item }) => !item.allDay)
      .filter((item) => item.start < last && item.end > first),
  );
  const earliest = localDate(now) === options.day ? now.getTime() : first;
  const available = freeSpans(working, busy, earliest);
  const preferred = options.preferredStart ? instant(options.preferredStart) : Number.NaN;
  const origin = Number.isFinite(preferred) ? preferred : Math.max(first, earliest);
  const candidates: Span[] = [];
  for (const gap of available) {
    // Busy items and "now" can end between quarter-hours. Only candidate starts
    // snap; preserve the requested duration, including existing 20-minute events.
    const aligned = first + Math.ceil((gap.start - first) / STEP) * STEP;
    for (let start = aligned; start + duration <= gap.end; start += STEP)
      candidates.push({ start, end: start + duration });
  }
  candidates.sort(
    (a, b) => Math.abs(a.start - origin) - Math.abs(b.start - origin) || a.start - b.start,
  );
  const selected: Span[] = [];
  for (const candidate of candidates) {
    if (selected.some((other) => intersects(candidate, other))) continue;
    selected.push(candidate);
    if (selected.length >= limit) break;
  }
  return selected.map((item) => ({
    start: new Date(item.start).toISOString(),
    end: new Date(item.end).toISOString(),
    allDay: false,
  }));
}
