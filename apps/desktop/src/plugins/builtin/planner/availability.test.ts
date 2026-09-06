import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { analyzeOverlap, suggestFreeSlots, type BusyInterval } from "./availability";
import { dateTimeInput } from "./dates";

const originalTZ = process.env.TZ;
beforeEach(() => {
  process.env.TZ = "America/Los_Angeles";
});
afterEach(() => {
  if (originalTZ === undefined) delete process.env.TZ;
  else process.env.TZ = originalTZ;
});
const day = "2026-09-04";
const time = (clock: string) => `${day}T${clock}:00-07:00`;
const busy = (key: string, start: string, end: string, allDay = false): BusyInterval => ({
  key,
  title: key,
  start,
  end,
  allDay,
});
const now = new Date("2026-09-01T12:00:00Z");
const starts = (values: { start: string }[]) => values.map((value) => dateTimeInput(value.start));

describe("Planner overlap analysis", () => {
  it("clips and unions duplicate and overlapping intervals without double counting", () => {
    const a = busy("note", time("08:45"), time("09:30"));
    const linkedEvent = busy("event", time("08:45"), time("09:30"));
    const b = busy("other", time("09:15"), time("10:30"));
    const touching = busy("next", time("10:00"), time("11:00"));
    const result = analyzeOverlap({ start: time("09:00"), end: time("10:00") }, [
      a,
      a,
      linkedEvent,
      b,
      touching,
    ]);
    expect(result.minutes).toBe(60);
    expect(result.items.map((item) => item.key)).toEqual(["note", "event", "other"]);
    expect(
      analyzeOverlap(
        { start: time("09:00"), end: time("10:00") },
        [a, linkedEvent, b],
        new Set(["note", "event"]),
      ).minutes,
    ).toBe(45);
  });

  it("treats endpoint touches as available and retains subminute overlap precision", () => {
    const selected = { start: time("09:00"), end: time("10:00") };
    expect(
      analyzeOverlap(selected, [
        busy("before", time("08:00"), time("09:00")),
        busy("after", time("10:00"), time("11:00")),
      ]).items,
    ).toEqual([]);
    expect(
      analyzeOverlap(selected, [busy("short", time("09:59"), `${day}T09:59:30-07:00`)]).minutes,
    ).toBe(0.5);
  });

  it("reports all-day context by local dates without adding blocked minutes", () => {
    const intervals = [
      busy("today", day, "2026-09-05", true),
      busy("tomorrow", "2026-09-05", "2026-09-06", true),
    ];
    expect(
      analyzeOverlap({ start: time("23:30"), end: "2026-09-05T00:15:00-07:00" }, intervals),
    ).toMatchObject({ minutes: 0, items: [], allDayItems: intervals });
    expect(
      analyzeOverlap({ start: time("09:00"), end: time("10:00") }, intervals).allDayItems.map(
        (item) => item.key,
      ),
    ).toEqual(["today"]);
  });

  it("ignores invalid busy ranges and rejects invalid selected ranges", () => {
    const invalid = [
      busy("backward", time("10:00"), time("09:00")),
      busy("invalid", "bad", time("11:00")),
      busy("civil", "2026-02-30T09:00:00Z", "2026-03-02T10:00:00Z"),
      busy("missing-zone", "2026-09-04T09:00:00", time("11:00")),
    ];
    expect(analyzeOverlap({ start: time("09:00"), end: time("10:00") }, invalid).minutes).toBe(0);
    expect(analyzeOverlap({ start: "invalid", end: time("10:00") }, [])).toEqual({
      minutes: 0,
      items: [],
      allDayItems: [],
    });
  });
});

describe("Planner free-slot suggestions", () => {
  it("offers three nearby nonoverlapping slots, with earlier times breaking distance ties", () => {
    const slots = suggestFreeSlots({
      day,
      durationMinutes: 30,
      preferredStart: time("11:00"),
      intervals: [],
      now,
    });
    expect(starts(slots)).toEqual([`${day}T11:00`, `${day}T10:30`, `${day}T11:30`]);
    expect(
      slots.every(
        (slot) => Date.parse(slot.end) - Date.parse(slot.start) === 30 * 60_000 && !slot.allDay,
      ),
    ).toBe(true);
  });

  it("unions task/event duplicates and clips busy intervals extending across days", () => {
    const night = busy("night", "2026-09-03T22:00:00-07:00", time("09:30"));
    const intervals = [
      night,
      night,
      busy("event-copy", night.start, night.end),
      busy("next-night", time("17:30"), "2026-09-05T07:00:00-07:00"),
    ];
    const slots = suggestFreeSlots({ day, durationMinutes: 30, intervals, now });
    expect(starts(slots)).toEqual([`${day}T09:30`, `${day}T10:00`, `${day}T10:30`]);
    expect(
      suggestFreeSlots({
        day,
        durationMinutes: 60,
        intervals,
        now,
        preferredStart: time("18:00"),
        limit: 1,
      }).map((slot) => dateTimeInput(slot.end)),
    ).toEqual([`${day}T17:30`]);
  });

  it("can exclude the block being moved while keeping completed work and other busy history", () => {
    const intervals = [
      busy("moving", time("09:00"), time("10:00")),
      busy("completed-work", time("10:00"), time("11:00")),
    ];
    expect(
      starts(
        suggestFreeSlots({ day, durationMinutes: 60, intervals, excludedKeys: ["moving"], now }),
      ),
    ).toEqual([`${day}T09:00`, `${day}T11:00`, `${day}T12:00`]);
  });

  it("starts at the next quarter hour after now today and preserves a 20-minute duration", () => {
    const slots = suggestFreeSlots({
      day,
      durationMinutes: 20,
      intervals: [],
      now: new Date(time("09:07")),
    });
    expect(starts(slots)).toEqual([`${day}T09:15`, `${day}T09:45`, `${day}T10:15`]);
    expect(
      slots.every((slot) => Date.parse(slot.end) - Date.parse(slot.start) === 20 * 60_000),
    ).toBe(true);
    expect(
      suggestFreeSlots({ day, durationMinutes: 30, intervals: [], now: new Date(time("18:00")) }),
    ).toEqual([]);
  });

  it("does not block timed recommendations for all-day events", () => {
    const slots = suggestFreeSlots({
      day,
      durationMinutes: 30,
      intervals: [busy("holiday", day, "2026-09-05", true)],
      now,
      limit: 1,
    });
    expect(starts(slots)).toEqual([`${day}T09:00`]);
  });

  it("preserves elapsed duration across the spring gap and never suggests nonexistent times", () => {
    const slots = suggestFreeSlots({
      day: "2026-03-08",
      durationMinutes: 60,
      preferredStart: "2026-03-08T01:30:00-08:00",
      intervals: [],
      now,
      startHour: 1,
      endHour: 4,
      limit: 1,
    });
    expect(slots).toEqual([
      { start: "2026-03-08T09:30:00.000Z", end: "2026-03-08T10:30:00.000Z", allDay: false },
    ]);
    expect(dateTimeInput(slots[0].end)).toBe("2026-03-08T03:30");
  });

  it("keeps repeated fall hours distinct and can suggest the second occurrence", () => {
    const repeated = busy(
      "first-occurrence",
      "2026-11-01T01:30:00-07:00",
      "2026-11-01T01:00:00-08:00",
    );
    const slots = suggestFreeSlots({
      day: "2026-11-01",
      durationMinutes: 30,
      preferredStart: "2026-11-01T01:30:00-08:00",
      intervals: [repeated],
      now,
      startHour: 1,
      endHour: 3,
      limit: 1,
    });
    expect(slots).toEqual([
      { start: "2026-11-01T09:30:00.000Z", end: "2026-11-01T10:00:00.000Z", allDay: false },
    ]);
    expect(analyzeOverlap(slots[0], [repeated]).minutes).toBe(0);
  });

  it("does not bridge a repeated-hour gap outside the selected working hours", () => {
    const slots = suggestFreeSlots({
      day: "2026-11-01",
      durationMinutes: 45,
      preferredStart: "2026-11-01T01:30:00-07:00",
      intervals: [],
      now,
      startHour: 1.5,
      endHour: 3,
      limit: 1,
    });
    expect(slots[0]?.start).toBe("2026-11-01T09:30:00.000Z");
  });

  it("returns no slots when the workday is full or inputs cannot define a safe duration", () => {
    const options = { day, durationMinutes: 30, intervals: [], now };
    expect(
      suggestFreeSlots({ ...options, intervals: [busy("full", time("08:00"), time("19:00"))] }),
    ).toEqual([]);
    for (const durationMinutes of [0, -15, 10, Number.NaN, Number.POSITIVE_INFINITY, 1440])
      expect(suggestFreeSlots({ ...options, durationMinutes })).toEqual([]);
    expect(suggestFreeSlots({ ...options, day: "2026-02-30" })).toEqual([]);
    expect(suggestFreeSlots({ ...options, now: new Date(Number.NaN) })).toEqual([]);
    expect(suggestFreeSlots({ ...options, startHour: 18, endHour: 9 })).toEqual([]);
    expect(suggestFreeSlots({ ...options, limit: 0 })).toEqual([]);
    process.env.TZ = "Pacific/Apia";
    expect(suggestFreeSlots({ ...options, day: "2011-12-30" })).toEqual([]);
  });
});
