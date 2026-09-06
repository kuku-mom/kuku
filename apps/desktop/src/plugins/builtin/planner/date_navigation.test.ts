import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  moveNavigationFocus,
  moveNavigationMonth,
  navigationMonthDays,
  placeDateNavigator,
  validNavigationDate,
} from "./date_navigation";

const previousTZ = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "America/Los_Angeles";
});
afterAll(() => {
  if (previousTZ === undefined) delete process.env.TZ;
  else process.env.TZ = previousTZ;
});

describe("Planner date navigation", () => {
  it("clamps month and year navigation to the last valid day", () => {
    expect(moveNavigationMonth("2024-01-31", 1)).toBe("2024-02-29");
    expect(moveNavigationMonth("2025-01-31", 1)).toBe("2025-02-28");
    expect(moveNavigationMonth("2024-02-29", 12)).toBe("2025-02-28");
    expect(moveNavigationMonth("2026-01-31", -1)).toBe("2025-12-31");
    expect(moveNavigationMonth("2026-12-31", 1)).toBe("2027-01-31");
  });

  it("creates a stable six-row Monday-first month across year boundaries", () => {
    const january = navigationMonthDays("2026-01-15");
    expect(january).toHaveLength(6);
    expect(january.every((week) => week.length === 7)).toBe(true);
    expect(january[0]).toEqual([
      "2025-12-29",
      "2025-12-30",
      "2025-12-31",
      "2026-01-01",
      "2026-01-02",
      "2026-01-03",
      "2026-01-04",
    ]);
    expect(january[5][6]).toBe("2026-02-08");
    expect(new Set(january.flat()).size).toBe(42);
    expect(navigationMonthDays("2024-02-01").flat()).toContain("2024-02-29");
  });

  it("moves keyboard focus by civil days through DST and between months", () => {
    expect(moveNavigationFocus("2026-03-08", "ArrowRight")).toBe("2026-03-09");
    expect(moveNavigationFocus("2026-11-01", "ArrowLeft")).toBe("2026-10-31");
    expect(moveNavigationFocus("2026-01-01", "ArrowUp")).toBe("2025-12-25");
    expect(moveNavigationFocus("2026-01-01", "ArrowDown")).toBe("2026-01-08");
    expect(moveNavigationFocus("2026-01-01", "Home")).toBe("2025-12-29");
    expect(moveNavigationFocus("2026-01-01", "End")).toBe("2026-01-04");
    expect(moveNavigationFocus("2026-03-31", "PageUp")).toBe("2026-02-28");
    expect(moveNavigationFocus("2024-02-29", "PageDown", true)).toBe("2025-02-28");
    expect(moveNavigationFocus("2026-01-01", "Enter")).toBeUndefined();
  });

  it("rejects invalid typed dates and overflow years", () => {
    expect(validNavigationDate("2026-02-30")).toBe(false);
    expect(validNavigationDate("2026-02-29")).toBe(false);
    expect(validNavigationDate("2024-02-29")).toBe(true);
    expect(moveNavigationMonth("2026-02-30", 1)).toBe("");
    expect(moveNavigationMonth("9999-12-31", 1)).toBe("");
    expect(validNavigationDate("0000-01-01")).toBe(false);
    const finalMonth = navigationMonthDays("9999-12-31").flat();
    expect(finalMonth).toContain("9999-12-31");
    expect(finalMonth).toContain("");
    expect(finalMonth.every((day) => !day || validNavigationDate(day))).toBe(true);
    expect(moveNavigationMonth("2026-01-01", 0.5)).toBe("");
    expect(navigationMonthDays("invalid")).toEqual([]);
  });

  it("keeps the popup inside a narrow Planner pane and flips above near its bottom", () => {
    const pane = { left: 256, top: 90, right: 706, bottom: 760 };
    expect(placeDateNavigator(pane, { left: 500, top: 110, right: 680, bottom: 140 }, 374)).toEqual(
      { left: 396, top: 147, width: 300, maxHeight: 374 },
    );
    expect(placeDateNavigator(pane, { left: 500, top: 650, right: 680, bottom: 680 }, 374)).toEqual(
      { left: 396, top: 269, width: 300, maxHeight: 374 },
    );
    const small = placeDateNavigator(
      { left: 100, top: 100, right: 300, bottom: 400 },
      { left: 120, top: 120, right: 250, bottom: 150 },
      374,
    );
    expect(small.left).toBe(110);
    expect(small.width).toBe(180);
    expect(small.top + small.maxHeight).toBeLessThanOrEqual(390);
  });

  it("shows the complete date form above the trigger when a narrow pane's task drawer is open", () => {
    const pane = { left: 256, top: 29, right: 706, bottom: 760 };
    const trigger = { left: 270, top: 421, right: 430, bottom: 448 };
    expect(placeDateNavigator(pane, trigger, 366)).toEqual({
      left: 270,
      top: 48,
      width: 300,
      maxHeight: 366,
    });
    // When neither side fits, retain the larger area and let the popup scroll.
    expect(placeDateNavigator(pane, trigger, 500)).toEqual({
      left: 270,
      top: 39,
      width: 300,
      maxHeight: 375,
    });
  });
});
