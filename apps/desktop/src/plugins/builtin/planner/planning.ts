import { addDays, dateFromKey } from "./dates";

export interface PlannedInterval {
  start: string;
  end: string;
  allDay?: boolean;
}

/** Count occupied time once, even when linked tasks and events share a block.
 * Midnight boundaries follow the local calendar; durations use elapsed time. */
export function plannedMinutes(day: string, intervals: readonly PlannedInterval[]): number {
  const first = dateFromKey(day).getTime();
  const last = dateFromKey(addDays(day, 1)).getTime();
  if (!Number.isFinite(first) || !Number.isFinite(last) || last <= first) return 0;

  const spans: { start: number; end: number }[] = [];
  for (const interval of intervals) {
    if (interval.allDay || !interval.start.includes("T") || !interval.end.includes("T")) continue;
    const start = Math.max(first, Date.parse(interval.start));
    const end = Math.min(last, Date.parse(interval.end));
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) spans.push({ start, end });
  }
  spans.sort((a, b) => a.start - b.start || a.end - b.end);
  if (!spans.length) return 0;

  let total = 0;
  let start = spans[0].start;
  let end = spans[0].end;
  for (let index = 1; index < spans.length; index++) {
    const span = spans[index];
    if (span.start > end) {
      total += end - start;
      start = span.start;
    }
    end = Math.max(end, span.end);
  }
  return (total + end - start) / 60_000;
}
