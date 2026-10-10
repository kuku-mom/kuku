import { describe, expect, it } from "vitest";

import { placeComposer, type ComposerRect } from "./composer_placement";

const rect = (left: number, top: number, right: number, bottom: number): ComposerRect => ({
  left,
  top,
  right,
  bottom,
});
const natural = { width: 360, height: 420 };

describe("Planner composer placement", () => {
  it("keeps the Friday composer inside the Planner instead of covering the right app panel", () => {
    const bounds = rect(256, 90, 1292, 960);
    const friday = rect(990, 500, 1090, 524);
    expect(placeComposer(bounds, friday, natural)).toEqual({
      left: 618,
      top: 488,
      width: 360,
      maxHeight: 420,
      placement: "left",
      reservedHeight: 0,
    });
  });

  it("places the form beside the entire selected slot when the right side fits", () => {
    expect(placeComposer(rect(100, 80, 1400, 980), rect(300, 400, 400, 470), natural)).toEqual({
      left: 412,
      top: 388,
      width: 360,
      maxHeight: 420,
      placement: "right",
      reservedHeight: 0,
    });
  });

  it("prefers full width on the left over a narrowed form on the right", () => {
    expect(placeComposer(rect(0, 0, 1000, 800), rect(400, 300, 650, 324), natural)).toMatchObject({
      left: 28,
      width: 360,
      placement: "left",
    });
  });

  it("narrows a side form only as far as 320 pixels before docking", () => {
    const target = rect(24, 200, 360, 224);
    expect(placeComposer(rect(0, 0, 744, 800), target, natural)).toMatchObject({
      width: 360,
      placement: "right",
    });
    expect(placeComposer(rect(0, 0, 720, 800), target, natural)).toMatchObject({
      left: 372,
      width: 336,
      placement: "right",
    });
    expect(placeComposer(rect(0, 0, 704, 800), target, natural)).toMatchObject({
      left: 372,
      width: 320,
      placement: "right",
    });
    expect(placeComposer(rect(0, 0, 703, 800), target, natural)).toMatchObject({
      width: 679,
      placement: "docked",
    });
    expect(placeComposer(rect(0, 0, 720, 800), rect(360, 200, 690, 224), natural)).toMatchObject({
      left: 12,
      width: 336,
      placement: "left",
    });
  });

  it("docks a narrow Planner at its own bottom and reports the space to reserve", () => {
    expect(placeComposer(rect(256, 100, 556, 700), rect(290, 220, 544, 244), natural)).toEqual({
      left: 268,
      top: 358,
      width: 276,
      maxHeight: 330,
      placement: "docked",
      reservedHeight: 354,
    });
  });

  it("keeps an expanded side form within the viewport without changing sides", () => {
    const bounds = rect(100, 100, 1400, 900);
    const target = rect(300, 750, 400, 774);
    expect(placeComposer(bounds, target, { width: 360, height: 200 })).toMatchObject({
      left: 412,
      top: 688,
      maxHeight: 200,
      placement: "right",
    });
    expect(placeComposer(bounds, target, { width: 360, height: 600 })).toMatchObject({
      left: 412,
      top: 288,
      maxHeight: 600,
      placement: "right",
    });
    expect(placeComposer(bounds, target, { width: 360, height: 1200 })).toMatchObject({
      left: 412,
      top: 112,
      maxHeight: 776,
      placement: "right",
    });
  });

  it("caps expanded docked fields at 55 percent of the Planner height", () => {
    const bounds = rect(0, 0, 400, 600);
    const target = rect(12, 200, 388, 224);
    expect(placeComposer(bounds, target, { width: 360, height: 200 })).toMatchObject({
      top: 388,
      maxHeight: 200,
      reservedHeight: 224,
    });
    expect(placeComposer(bounds, target, { width: 360, height: 900 })).toMatchObject({
      top: 258,
      maxHeight: 330,
      reservedHeight: 354,
    });
  });

  it("collapses padding safely for tiny or empty bounds", () => {
    expect(placeComposer(rect(100, 100, 110, 120), rect(100, 100, 110, 120), natural)).toEqual({
      left: 105,
      top: 110,
      width: 0,
      maxHeight: 0,
      placement: "docked",
      reservedHeight: 20,
    });
    expect(placeComposer(rect(100, 100, 100, 100), rect(100, 100, 100, 100), natural)).toEqual({
      left: 100,
      top: 100,
      width: 0,
      maxHeight: 0,
      placement: "docked",
      reservedHeight: 0,
    });
  });

  it("always produces finite, nonnegative sizes contained in the supplied bounds", () => {
    for (const width of [0, 10, 23, 120, 320, 450, 720, 1200]) {
      for (const height of [0, 10, 24, 90, 400, 900]) {
        for (const formHeight of [0, 200, 1000]) {
          const bounds = rect(50, 70, 50 + width, 70 + height);
          const result = placeComposer(bounds, rect(80, 100, 150, 130), {
            width: 360,
            height: formHeight,
          });
          expect(
            Object.values(result)
              .filter((value) => typeof value === "number")
              .every(Number.isFinite),
          ).toBe(true);
          expect(result.width).toBeGreaterThanOrEqual(0);
          expect(result.maxHeight).toBeGreaterThanOrEqual(0);
          expect(result.reservedHeight).toBeGreaterThanOrEqual(0);
          expect(result.reservedHeight).toBeLessThanOrEqual(height);
          expect(result.left).toBeGreaterThanOrEqual(bounds.left);
          expect(result.top).toBeGreaterThanOrEqual(bounds.top);
          expect(result.left + result.width).toBeLessThanOrEqual(bounds.right);
          expect(result.top + result.maxHeight).toBeLessThanOrEqual(bounds.bottom);
        }
      }
    }
  });
});
