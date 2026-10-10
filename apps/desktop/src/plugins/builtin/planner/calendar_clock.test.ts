import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { calendarClock, calendarScrollTarget, initialCalendarScroll } from "./calendar_clock";

const originalTZ = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "America/Los_Angeles";
});
afterAll(() => {
  if (originalTZ === undefined) delete process.env.TZ;
  else process.env.TZ = originalTZ;
});

const viewport = { height: 600, headerHeight: 120, scrollHeight: 1272 };

describe("calendar clock and scroll restoration", () => {
  it("positions civil time consistently through daylight saving transitions", () => {
    expect(calendarClock(new Date("2026-03-08T09:59:00Z"))).toEqual({
      day: "2026-03-08",
      minute: 119,
    });
    expect(calendarClock(new Date("2026-03-08T10:00:00Z"))).toEqual({
      day: "2026-03-08",
      minute: 180,
    });
    expect(calendarClock(new Date("2026-11-01T08:30:00Z"))).toEqual(
      calendarClock(new Date("2026-11-01T09:30:00Z")),
    );
    expect(calendarClock(new Date("2026-09-05T06:59:00Z")).day).toBe("2026-09-04");
    expect(calendarClock(new Date("2026-09-05T07:00:00Z")).day).toBe("2026-09-05");
  });

  it("restores deliberate scroll positions including midnight before considering the clock", () => {
    const now = new Date("2026-09-04T15:00:00-07:00");
    expect(initialCalendarScroll(["2026-09-04"], now, 0, viewport, 0.8)).toBe(0);
    expect(initialCalendarScroll(["2026-09-04"], now, 210, viewport, 0.8)).toBe(210);
    expect(initialCalendarScroll(["2026-09-06"], now, 210, viewport, 0.8)).toBe(210);
    expect(initialCalendarScroll(["2026-09-04"], now, 900, viewport, 0.8)).toBe(672);
  });

  it("opens near now when today is visible, and near 09:00 for another day", () => {
    const now = new Date("2026-09-04T15:00:00-07:00");
    expect(initialCalendarScroll(["2026-09-04"], now, undefined, viewport, 0.8)).toBe(560);
    expect(initialCalendarScroll(["2026-09-06"], now, undefined, viewport, 0.8)).toBe(272);
    expect(initialCalendarScroll(["2026-09-04"], now, Number.NaN, viewport, 0.8)).toBe(560);
  });

  it("keeps early and late hours in bounds for short and tall windows", () => {
    expect(calendarScrollTarget(0, viewport, 0.8)).toBe(0);
    expect(calendarScrollTarget(1439, viewport, 0.8)).toBe(672);
    expect(calendarScrollTarget(600, { ...viewport, height: 240 }, 0.8)).toBe(440);
    expect(calendarScrollTarget(600, { ...viewport, height: 1400 }, 0.8)).toBe(0);
  });
});
