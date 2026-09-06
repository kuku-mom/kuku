import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { plannedMinutes } from "./planning";

const originalTZ = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "America/Los_Angeles";
});
afterAll(() => {
  if (originalTZ === undefined) delete process.env.TZ;
  else process.env.TZ = originalTZ;
});

const interval = (start: string, end: string, allDay = false) => ({ start, end, allDay });

describe("daily planned time", () => {
  it("counts overlapping plans and duplicate linked blocks only once", () => {
    const original = interval("2026-09-04T09:00:00-07:00", "2026-09-04T10:00:00-07:00");
    const spans = [
      interval("2026-09-04T10:00:00-07:00", "2026-09-04T10:30:00-07:00"),
      original,
      interval("2026-09-04T09:30:00-07:00", "2026-09-04T10:15:00-07:00"),
      { ...original },
      interval("2026-09-04T11:00:00-07:00", "2026-09-04T11:30:00-07:00"),
    ];
    expect(plannedMinutes("2026-09-04", spans)).toBe(120);
    expect(spans[0].start).toBe("2026-09-04T10:00:00-07:00");
  });

  it("clips at local midnight with exclusive end dates across adjacent days", () => {
    const spans = [
      interval("2026-09-04T23:30:00-07:00", "2026-09-05T01:30:00-07:00"),
      interval("2026-09-05T23:00:00-07:00", "2026-09-06T00:00:00-07:00"),
    ];
    expect(plannedMinutes("2026-09-04", spans)).toBe(30);
    expect(plannedMinutes("2026-09-05", spans)).toBe(150);
    expect(plannedMinutes("2026-09-06", spans)).toBe(0);
    expect(
      plannedMinutes("2026-09-04", [interval("2026-09-05T06:00:00Z", "2026-09-05T08:00:00Z")]),
    ).toBe(60);
  });

  it("omits all-day events, reversed or malformed ranges, and invalid days", () => {
    const spans = [
      interval("2026-09-04", "2026-09-06", true),
      interval("2026-09-04", "2026-09-06"),
      interval("2026-09-04T09:00:00-07:00", "2026-09-04T10:00:00-07:00", true),
      interval("2026-09-04T11:00:00-07:00", "2026-09-04T10:00:00-07:00"),
      interval("2026-09-04T10:00:00-07:00", "2026-09-04T10:00:00-07:00"),
      interval("not-a-time", "2026-09-04T10:00:00-07:00"),
      interval("2026-09-04T09:00:00-07:00", "invalid"),
    ];
    expect(plannedMinutes("2026-09-04", spans)).toBe(0);
    expect(plannedMinutes("2026-02-30", spans)).toBe(0);
    expect(plannedMinutes("", spans)).toBe(0);
    expect(plannedMinutes("2026-09-04", [])).toBe(0);
  });

  it("uses the 23-hour spring day and actual elapsed time through the missing hour", () => {
    expect(
      plannedMinutes("2026-03-08", [
        interval("2026-03-07T23:00:00-08:00", "2026-03-09T01:00:00-07:00"),
      ]),
    ).toBe(23 * 60);
    expect(
      plannedMinutes("2026-03-08", [
        interval("2026-03-08T01:30:00-08:00", "2026-03-08T03:30:00-07:00"),
      ]),
    ).toBe(60);
  });

  it("counts distinct repeated-hour occurrences and clips the 25-hour fall day", () => {
    expect(
      plannedMinutes("2026-11-01", [
        interval("2026-10-31T23:00:00-07:00", "2026-11-02T01:00:00-08:00"),
      ]),
    ).toBe(25 * 60);
    expect(
      plannedMinutes("2026-11-01", [
        interval("2026-11-01T01:00:00-07:00", "2026-11-01T01:30:00-07:00"),
        interval("2026-11-01T01:00:00-08:00", "2026-11-01T01:30:00-08:00"),
      ]),
    ).toBe(60);
  });
});
