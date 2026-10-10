import type { PlannerTask } from "~/lib/planner_tasks";

import type { ExternalItem, TaskFilter } from "./types";

export function localDate(date = new Date()): string {
  if (!Number.isFinite(date.getTime())) return "";
  return `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

// Civil date arithmetic must not parse YYYY-MM-DD as a UTC instant or add
// 86,400,000 ms to local midnight: both shift dates around time-zone changes.
function calendarDate(key: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return new Date(NaN);
  const date = new Date(`${key}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === key
    ? date
    : new Date(NaN);
}

export function dateFromKey(key: string): Date {
  if (!Number.isFinite(calendarDate(key).getTime())) return new Date(NaN);
  const date = new Date(`${key}T00:00:00`);
  return localDate(date) === key ? date : new Date(NaN);
}
export function addDays(key: string, days: number): string {
  const date = calendarDate(key);
  if (!Number.isFinite(date.getTime()) || !Number.isInteger(days)) return "";
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
export function weekDays(anchor: string): string[] {
  const date = calendarDate(anchor);
  if (!Number.isFinite(date.getTime())) return [];
  const monday = addDays(anchor, -((date.getUTCDay() + 6) % 7));
  return Array.from({ length: 7 }, (_, index) => addDays(monday, index));
}
export function calendarDays(anchor: string, visibleDays: 1 | 3 | 7 = 7): string[] {
  if (visibleDays === 7) return weekDays(anchor);
  if (!Number.isFinite(calendarDate(anchor).getTime())) return [];
  return Array.from({ length: visibleDays }, (_, index) => addDays(anchor, index));
}
export function dateTimeInput(iso?: string): string {
  if (!iso) return "";
  const date = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? dateFromKey(iso) : new Date(iso);
  if (!Number.isFinite(date.getTime())) return "";
  return `${localDate(date)}T${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** Reject nonexistent local times. Preserve an existing instant when a saved
 * time is in the second occurrence of a repeated DST hour and is left unchanged.
 * A newly selected ambiguous time uses JavaScript's earlier occurrence. */
export function localDateTimeToISO(value: string, preferredISO?: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  if (preferredISO && dateTimeInput(preferredISO) === value)
    return new Date(preferredISO).toISOString();
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || dateTimeInput(date.toISOString()) !== value) return null;
  return date.toISOString();
}
export function taskDay(task: PlannerTask): string | undefined {
  return task.metadata?.scheduledStart
    ? localDate(new Date(task.metadata.scheduledStart))
    : task.metadata?.plannedDate;
}
export function matchesFilter(task: PlannerTask, filter: TaskFilter, today = localDate()): boolean {
  if (filter === "completed") return task.checked;
  if (task.checked) return false;
  const day = taskDay(task);
  const due = task.metadata?.dueDate;
  if (filter === "today") return !!((day && day <= today) || (due && due <= today));
  if (filter === "upcoming") return !!((day && day > today) || (due && due > today));
  return !day && !due;
}
export function blockFor(day: string, minute: number, duration = 30) {
  if (!Number.isFinite(minute) || !Number.isFinite(duration))
    throw new RangeError("Invalid task time or duration.");
  const snapped = Math.max(0, Math.min(1425, Math.round(minute / 15) * 15));
  const wallTime = `${day}T${String(Math.floor(snapped / 60)).padStart(2, "0")}:${String(snapped % 60).padStart(2, "0")}`;
  const scheduledStart = localDateTimeToISO(wallTime);
  if (!scheduledStart) throw new RangeError("This local time does not exist. Choose another time.");
  const end = new Date(
    new Date(scheduledStart).getTime() + Math.max(15, Math.round(duration / 15) * 15) * 60000,
  );
  if (!Number.isFinite(end.getTime())) throw new RangeError("Invalid task duration.");
  return {
    scheduledStart,
    scheduledEnd: end.toISOString(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    plannedDate: day,
  };
}
export function itemOnDay(item: ExternalItem, day: string): boolean {
  if (!Number.isFinite(calendarDate(day).getTime())) return false;
  if (item.kind === "reminder") return item.dueDate?.slice(0, 10) === day;
  if (!item.start) return false;
  if (item.allDay) {
    const start = item.start.slice(0, 10);
    const end = item.end?.slice(0, 10) ?? addDays(start, 1);
    return (
      Number.isFinite(calendarDate(start).getTime()) &&
      Number.isFinite(calendarDate(end).getTime()) &&
      start <= day &&
      end > day
    );
  }
  return !!item.end && segmentOnDay(item.start, item.end, day) !== null;
}
export function segmentOnDay(
  start: string,
  end: string,
  day: string,
): { top: number; height: number } | null {
  const first = dateFromKey(day).getTime();
  const last = dateFromKey(addDays(day, 1)).getTime();
  const a = new Date(start).getTime(),
    b = new Date(end).getTime();
  if (![a, b, first, last].every(Number.isFinite) || b <= a || a >= last || b <= first) return null;
  const from = Math.max(first, a),
    to = Math.min(last, b);
  const localMinute = (ms: number) => {
    const date = new Date(ms);
    return (
      date.getHours() * 60 +
      date.getMinutes() +
      date.getSeconds() / 60 +
      date.getMilliseconds() / 60000
    );
  };
  let top = a <= first ? 0 : localMinute(from);
  let bottom = b >= last ? 1440 : Math.max(localMinute(to), localMinute(to - 1) + 1 / 60000);
  const offset = new Date(from).getTimezoneOffset();
  if (new Date(to - 1).getTimezoneOffset() > offset) {
    // A fixed 24-row grid cannot display the repeated hour twice. Cover both
    // wall-clock spans so folded occurrences share collision lanes correctly.
    let lo = from,
      hi = to - 1;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (new Date(mid).getTimezoneOffset() === offset) lo = mid + 1;
      else hi = mid;
    }
    top = Math.min(top, localMinute(lo));
    bottom = Math.max(bottom, localMinute(lo - 1) + 1 / 60000);
  }
  const height = bottom - top;
  return height > 0 ? { top, height } : null;
}

export interface SegmentLayout {
  top: number;
  height: number;
  left: number;
  width: number;
}

/** Lay out tasks and provider events together. top/height use local minutes;
 * left/width are fractions of the day column. Ends are exclusive. */
export function layoutSegments(
  entries: { key: string; start: string; end: string }[],
  day: string,
): Record<string, SegmentLayout> {
  const segments = entries
    .flatMap((entry) => {
      const position = segmentOnDay(entry.start, entry.end, day);
      return position ? [{ key: entry.key, ...position }] : [];
    })
    .sort(
      (a, b) =>
        a.top - b.top || b.height - a.height || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    );
  const result: Record<string, SegmentLayout> = Object.create(null);
  const seen = new Set<string>();
  let group: ((typeof segments)[number] & { lane: number })[] = [];
  let laneEnds: number[] = [];
  let groupEnd = -Infinity;
  const flush = () => {
    for (const segment of group)
      result[segment.key] = {
        top: segment.top,
        height: segment.height,
        left: segment.lane / laneEnds.length,
        width: 1 / laneEnds.length,
      };
    group = [];
    laneEnds = [];
    groupEnd = -Infinity;
  };
  for (const segment of segments) {
    if (seen.has(segment.key)) continue;
    seen.add(segment.key);
    if (segment.top >= groupEnd) flush();
    let lane = laneEnds.findIndex((end) => end <= segment.top);
    if (lane < 0) lane = laneEnds.length;
    const end = segment.top + segment.height;
    laneEnds[lane] = end;
    groupEnd = Math.max(groupEnd, end);
    group.push({ ...segment, lane });
  }
  flush();
  return result;
}
