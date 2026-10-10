import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { PlannerTask } from "~/lib/planner_tasks";

import type { ExternalItem } from "./types";

import {
  addDays,
  blockFor,
  calendarDays,
  dateFromKey,
  dateTimeInput,
  itemOnDay,
  layoutSegments,
  localDate,
  localDateTimeToISO,
  matchesFilter,
  segmentOnDay,
  weekDays,
} from "./dates";

const originalTZ = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "America/Los_Angeles";
});
afterAll(() => {
  if (originalTZ === undefined) delete process.env.TZ;
  else process.env.TZ = originalTZ;
});
const entry = (key: string, start: string, end: string) => ({ key, start, end });

describe("Planner civil dates and task allocation", () => {
  it("keeps unfinished past plans visible today and covers every pending task", () => {
    const task: PlannerTask = {
      id: "one",
      path: "Tasks/Inbox.md",
      title: "Task",
      checked: false,
      metadata: { id: "one", plannedDate: "2026-03-08" },
      sourceStart: 0,
      sourceEnd: 1,
    };
    expect(matchesFilter(task, "today", "2026-03-09")).toBe(true);
    const days = [undefined, "2026-03-08", "2026-03-09", "2026-03-10"];
    for (const plannedDate of days)
      for (const dueDate of days) {
        const pending = { ...task, metadata: { id: "one", plannedDate, dueDate } };
        expect(
          ["today", "upcoming", "unplanned"].some((filter) =>
            matchesFilter(pending, filter as "today" | "upcoming" | "unplanned", "2026-03-09"),
          ),
        ).toBe(true);
        expect(matchesFilter(pending, "completed", "2026-03-09")).toBe(false);
      }
    const scheduled = {
      ...task,
      metadata: {
        id: "one",
        scheduledStart: "2026-03-08T10:00:00-07:00",
        scheduledEnd: "2026-03-08T10:30:00-07:00",
      },
    };
    expect(matchesFilter(scheduled, "today", "2026-03-09")).toBe(true);
    expect(matchesFilter({ ...task, checked: true }, "today", "2026-03-09")).toBe(false);
    expect(matchesFilter({ ...task, checked: true }, "completed", "2026-03-09")).toBe(true);
  });

  it("keeps date keys local and starts weeks on Monday across year and DST changes", () => {
    expect(localDate(dateFromKey("2026-03-08"))).toBe("2026-03-08");
    expect(dateFromKey("2026-03-08").getHours()).toBe(0);
    expect(addDays("2026-03-08", 1)).toBe("2026-03-09");
    expect(addDays("2026-11-01", 1)).toBe("2026-11-02");
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
    expect(weekDays("2026-01-04")).toEqual([
      "2025-12-29",
      "2025-12-30",
      "2025-12-31",
      "2026-01-01",
      "2026-01-02",
      "2026-01-03",
      "2026-01-04",
    ]);
    expect(weekDays("2026-03-09")[0]).toBe("2026-03-09");
    expect(dateTimeInput("2026-03-08")).toBe("2026-03-08T00:00");
    expect(dateFromKey("2026-02-30").getTime()).toBeNaN();
    expect(weekDays("invalid")).toEqual([]);
  });

  it("keeps compact calendar views on the selected date across weeks, years, and DST", () => {
    expect(calendarDays("2026-01-04", 1)).toEqual(["2026-01-04"]);
    expect(calendarDays("2026-01-04", 3)).toEqual(["2026-01-04", "2026-01-05", "2026-01-06"]);
    expect(calendarDays("2026-12-31", 3)).toEqual(["2026-12-31", "2027-01-01", "2027-01-02"]);
    expect(calendarDays("2026-03-07", 3)).toEqual(["2026-03-07", "2026-03-08", "2026-03-09"]);
    expect(calendarDays("2026-10-31", 3)).toEqual(["2026-10-31", "2026-11-01", "2026-11-02"]);
    expect(calendarDays("2026-01-04")).toEqual(weekDays("2026-01-04"));
    expect(calendarDays("2026-01-04", 7)).toEqual(weekDays("2026-01-04"));
    expect(calendarDays("invalid", 1)).toEqual([]);
    expect(calendarDays("2026-02-30", 3)).toEqual([]);
  });

  it("rejects nonexistent spring-forward times and preserves saved second-occurrence times", () => {
    expect(localDateTimeToISO("2026-03-08T02:30")).toBeNull();
    expect(localDateTimeToISO("2026-02-30T12:00")).toBeNull();
    expect(localDateTimeToISO("2026-03-08T24:00")).toBeNull();
    expect(localDateTimeToISO("2026-11-01T01:30")).toBe("2026-11-01T08:30:00.000Z");
    expect(localDateTimeToISO("2026-11-01T01:30", "2026-11-01T09:30:00Z")).toBe(
      "2026-11-01T09:30:00.000Z",
    );
    expect(dateTimeInput("2026-11-01T09:30:00Z")).toBe("2026-11-01T01:30");
    expect(() => blockFor("2026-03-08", 150)).toThrow("does not exist");
  });

  it("snaps start and duration to 15 minutes, defaults to 30, and preserves elapsed duration across DST", () => {
    const regular = blockFor("2026-03-07", 9 * 60 + 8);
    expect(dateTimeInput(regular.scheduledStart)).toBe("2026-03-07T09:15");
    expect(dateTimeInput(regular.scheduledEnd)).toBe("2026-03-07T09:45");
    expect(dateTimeInput(blockFor("2026-03-07", -30, 1).scheduledEnd)).toBe("2026-03-07T00:15");
    expect(dateTimeInput(blockFor("2026-03-07", 1500).scheduledStart)).toBe("2026-03-07T23:45");
    expect(dateTimeInput(blockFor("2026-03-07", 540, 38).scheduledEnd)).toBe("2026-03-07T09:45");
    const spring = blockFor("2026-03-08", 105);
    expect(dateTimeInput(spring.scheduledEnd)).toBe("2026-03-08T03:15");
    expect(Date.parse(spring.scheduledEnd) - Date.parse(spring.scheduledStart)).toBe(30 * 60000);
    expect(spring.plannedDate).toBe("2026-03-08");
    expect(() => blockFor("2026-03-07", NaN)).toThrow();
  });
});

describe("Planner day segments", () => {
  it("treats all-day end dates as exclusive without UTC date shifts", () => {
    const item: ExternalItem = {
      id: "event",
      provider: "google",
      calendarId: "one",
      title: "Conference",
      kind: "event",
      allDay: true,
      start: "2026-03-07",
      end: "2026-03-09",
    };
    expect(itemOnDay(item, "2026-03-06")).toBe(false);
    expect(itemOnDay(item, "2026-03-07")).toBe(true);
    expect(itemOnDay(item, "2026-03-08")).toBe(true);
    expect(itemOnDay(item, "2026-03-09")).toBe(false);
    expect(itemOnDay({ ...item, end: undefined }, "2026-03-08")).toBe(false);
  });

  it("clips multi-day spans to local midnights on 23- and 25-hour days", () => {
    expect(
      segmentOnDay("2026-03-07T23:00:00-08:00", "2026-03-09T01:00:00-07:00", "2026-03-08"),
    ).toEqual({ top: 0, height: 1440 });
    expect(
      segmentOnDay("2026-03-07T23:00:00-08:00", "2026-03-09T01:00:00-07:00", "2026-03-09"),
    ).toEqual({ top: 0, height: 60 });
    expect(
      segmentOnDay("2026-10-31T23:00:00-07:00", "2026-11-02T01:00:00-08:00", "2026-11-01"),
    ).toEqual({ top: 0, height: 1440 });
    expect(
      segmentOnDay("2026-03-07T23:00:00-08:00", "2026-03-08T00:00:00-08:00", "2026-03-08"),
    ).toBeNull();
    expect(segmentOnDay("bad", "bad", "2026-03-08")).toBeNull();
    expect(
      segmentOnDay("2026-03-08T10:00:00-07:00", "2026-03-08T09:00:00-07:00", "2026-03-08"),
    ).toBeNull();
  });

  it("covers both clock spans for a fall-back event and retains short-event dimensions", () => {
    expect(
      segmentOnDay("2026-11-01T01:45:00-07:00", "2026-11-01T01:15:00-08:00", "2026-11-01"),
    ).toEqual({ top: 60, height: 60 });
    expect(
      segmentOnDay("2026-11-01T01:30:00-07:00", "2026-11-01T01:00:00-08:00", "2026-11-01"),
    ).toEqual({ top: 90, height: 30 });
    expect(
      segmentOnDay("2026-03-08T01:30:00-08:00", "2026-03-08T03:00:00-07:00", "2026-03-08"),
    ).toEqual({ top: 90, height: 90 });
    expect(
      segmentOnDay("2026-03-08T23:55:00-07:00", "2026-03-09T00:00:00-07:00", "2026-03-08"),
    ).toEqual({ top: 1435, height: 5 });
  });
});

describe("Unified task and event collision lanes", () => {
  it("gives adjacent intervals full width, including sub-15-minute events", () => {
    const layout = layoutSegments(
      [
        entry("event", "2026-03-09T10:00:00-07:00", "2026-03-09T10:05:00-07:00"),
        entry("task", "2026-03-09T10:05:00-07:00", "2026-03-09T10:10:00-07:00"),
      ],
      "2026-03-09",
    );
    expect(layout.event).toEqual({ top: 600, height: 5, left: 0, width: 1 });
    expect(layout.task).toEqual({ top: 605, height: 5, left: 0, width: 1 });
  });

  it("uses stable minimal lanes for nested overlaps and reuses lanes after an event ends", () => {
    const entries = [
      entry("outer", "2026-03-09T09:00:00-07:00", "2026-03-09T12:00:00-07:00"),
      entry("short", "2026-03-09T09:00:00-07:00", "2026-03-09T10:00:00-07:00"),
      entry("inner", "2026-03-09T09:30:00-07:00", "2026-03-09T10:30:00-07:00"),
      entry("reuse", "2026-03-09T10:00:00-07:00", "2026-03-09T11:00:00-07:00"),
      entry("later", "2026-03-09T12:00:00-07:00", "2026-03-09T13:00:00-07:00"),
    ];
    const layout = layoutSegments(entries, "2026-03-09");
    expect(layout).toEqual(layoutSegments([...entries].reverse(), "2026-03-09"));
    expect(layout.outer.left).toBe(0);
    expect(layout.short.left).toBe(1 / 3);
    expect(layout.inner.left).toBe(2 / 3);
    expect(layout.reuse.left).toBe(1 / 3);
    expect(layout.outer.width).toBe(1 / 3);
    expect(layout.later).toEqual({ top: 720, height: 60, left: 0, width: 1 });
  });

  it("shares lanes across multi-day DST spans and folded wall-clock occurrences", () => {
    const layout = layoutSegments(
      [
        entry("overnight", "2026-10-31T23:30:00-07:00", "2026-11-02T00:30:00-08:00"),
        entry("first", "2026-11-01T01:00:00-07:00", "2026-11-01T01:30:00-07:00"),
        entry("second", "2026-11-01T01:00:00-08:00", "2026-11-01T01:30:00-08:00"),
      ],
      "2026-11-01",
    );
    expect(layout.overnight.height).toBe(1440);
    expect(layout.first.top).toBe(60);
    expect(layout.second.top).toBe(60);
    expect(layout.first.left).not.toBe(layout.second.left);
    expect(Object.values(layout).every((segment) => segment.width === 1 / 3)).toBe(true);
  });
});
