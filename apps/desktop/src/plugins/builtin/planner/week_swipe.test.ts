import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createWeekSwipeRecognizer, type WeekSwipeSample } from "./week_swipe";

const wheel = (deltaX: number, deltaY = 0, extra: Partial<WeekSwipeSample> = {}) => ({
  deltaX,
  deltaY,
  deltaMode: 0,
  ...extra,
});
function fixture() {
  const onPreview = vi.fn();
  const onCommit = vi.fn();
  const onRelease = vi.fn();
  const swipe = createWeekSwipeRecognizer({
    onPreview,
    onCommit,
    onRelease,
    now: () => Date.now(),
  });
  return { swipe, onPreview, onCommit, onRelease };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("Planner trackpad week swipe", () => {
  it("leaves vertical scrolling untouched and locks its axis for the gesture", () => {
    const { swipe, onPreview, onCommit, onRelease } = fixture();
    expect(swipe.handle(wheel(2, 30))).toBe(false);
    expect(swipe.handle(wheel(130, 0))).toBe(false);
    vi.advanceTimersByTime(180);
    expect(onPreview).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
    expect(onRelease).not.toHaveBeenCalled();
  });

  it("leaves ambiguous diagonal movement native until horizontal intent is clear", () => {
    const { swipe, onPreview, onCommit } = fixture();
    for (let sample = 0; sample < 10; sample++) expect(swipe.handle(wheel(15, 15))).toBe(false);
    expect(onPreview).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(180);
    expect(swipe.handle(wheel(4, 1))).toBe(false);
    expect(swipe.handle(wheel(12, 1))).toBe(true);
    expect(onPreview.mock.calls.at(-1)?.[0]).toBeLessThan(0);
  });

  it("does not count native diagonal scrolling toward a later horizontal swipe", () => {
    const { swipe, onPreview, onCommit } = fixture();
    for (let sample = 0; sample < 10; sample++) expect(swipe.handle(wheel(15, 15))).toBe(false);
    expect(swipe.handle(wheel(55))).toBe(true);
    expect(onPreview.mock.calls.at(-1)?.[0]).toBe(-38.5);
    expect(onCommit).not.toHaveBeenCalled();
    expect(swipe.handle(wheel(64))).toBe(true);
    expect(onCommit).not.toHaveBeenCalled();
    expect(swipe.handle(wheel(1))).toBe(true);
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it.each([
    { name: "pinch", sample: wheel(5, 0, { ctrlKey: true }) },
    { name: "line wheel", sample: wheel(5, 0, { deltaMode: 1 }) },
    { name: "page wheel", sample: wheel(5, 0, { deltaMode: 2 }) },
    { name: "invalid sample", sample: wheel(Number.NaN) },
  ])("keeps the committed latch across a $name inside the same burst", ({ sample }) => {
    const { swipe, onCommit } = fixture();
    swipe.handle(wheel(130));
    vi.advanceTimersByTime(60);
    expect(swipe.handle(sample)).toBe(false);
    vi.advanceTimersByTime(60);
    expect(swipe.handle(wheel(130))).toBe(false);
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(1);
    vi.advanceTimersByTime(180);
    expect(swipe.handle(wheel(130))).toBe(true);
    expect(onCommit).toHaveBeenCalledTimes(2);
  });

  it("does not start another preview after an ignored input until the burst ends", () => {
    const { swipe, onPreview, onCommit, onRelease } = fixture();
    swipe.handle(wheel(60));
    expect(swipe.handle(wheel(5, 0, { ctrlKey: true }))).toBe(false);
    expect(onRelease).toHaveBeenCalledTimes(1);
    expect(swipe.handle(wheel(1000))).toBe(false);
    expect(onPreview.mock.calls.map(([offset]) => offset)).toEqual([-42, 0]);
    expect(onCommit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(180);
    swipe.handle(wheel(40));
    expect(onPreview.mock.calls.at(-1)?.[0]).toBe(-28);
  });

  it("commits once and consumes the entire horizontal inertia tail", () => {
    const { swipe, onCommit, onRelease } = fixture();
    for (const delta of [35, 35, 35, 35, 100, 70, 50, 30, 10, 2]) {
      vi.advanceTimersByTime(60);
      expect(swipe.handle(wheel(delta, 1))).toBe(true);
    }
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(1);
    expect(onRelease).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(179);
    swipe.handle(wheel(200));
    expect(onCommit).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(180);
    swipe.handle(wheel(-130));
    expect(onCommit.mock.calls).toEqual([[1], [-1]]);
  });

  it("lets a quick reversal cancel before the commit threshold", () => {
    const { swipe, onPreview, onCommit, onRelease } = fixture();
    expect(swipe.handle(wheel(65))).toBe(true);
    expect(swipe.handle(wheel(-65))).toBe(true);
    expect(onPreview.mock.calls.at(-1)?.[0]).toBe(-0);
    vi.advanceTimersByTime(180);
    expect(onPreview.mock.calls.at(-1)?.[0]).toBe(0);
    expect(onCommit).not.toHaveBeenCalled();
    expect(onRelease).toHaveBeenCalledTimes(1);
  });

  it("can reverse the eventual direction before committing", () => {
    const { swipe, onCommit } = fixture();
    swipe.handle(wheel(40));
    swipe.handle(wheel(-170));
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(-1);
  });

  it("limits preview to 96 pixels and enables settling before returning to zero", () => {
    const calls: (number | string)[] = [];
    const swipe = createWeekSwipeRecognizer({
      onPreview: (offset) => calls.push(offset),
      onCommit: () => calls.push("commit"),
      onRelease: () => calls.push("release"),
    });
    swipe.handle(wheel(500));
    expect(calls).toEqual([-96, "commit", "release", 0]);
    swipe.dispose();
  });

  it("never consumes vertical samples even during a horizontal preview or inertia tail", () => {
    const { swipe, onCommit } = fixture();
    expect(swipe.handle(wheel(7))).toBe(false);
    expect(swipe.handle(wheel(1, 5))).toBe(false);
    swipe.cancel();
    swipe.handle(wheel(40));
    expect(swipe.handle(wheel(0, 50))).toBe(false);
    expect(swipe.handle(wheel(3, 50))).toBe(false);
    swipe.handle(wheel(80));
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(1);
    expect(swipe.handle(wheel(0, 50))).toBe(false);
    expect(swipe.handle(wheel(20, 1))).toBe(true);
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it.each(["ctrlKey", "metaKey", "altKey", "shiftKey"] as const)(
    "does not intercept %s wheel combinations",
    (modifier) => {
      const { swipe, onPreview, onCommit } = fixture();
      expect(swipe.handle(wheel(200, 1, { [modifier]: true }))).toBe(false);
      expect(onPreview).not.toHaveBeenCalled();
      expect(onCommit).not.toHaveBeenCalled();
    },
  );

  it.each([1, 2])("preserves nonpixel deltaMode=%s scrolling", (deltaMode) => {
    const { swipe, onCommit } = fixture();
    expect(swipe.handle(wheel(300, 1, { deltaMode }))).toBe(false);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("uses arrival time rather than mixing DOM event timestamp clocks", () => {
    const { swipe, onCommit } = fixture();
    swipe.handle(wheel(70, 0, { timeStamp: 1 }));
    vi.advanceTimersByTime(30);
    swipe.handle(wheel(70, 0, { timeStamp: 1_000_000_000_000 }));
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("suspends UI changes without starting a burst or extending its idle deadline", () => {
    const { swipe, onPreview, onCommit } = fixture();
    swipe.suspend();
    expect(vi.getTimerCount()).toBe(0);
    swipe.handle(wheel(40));
    vi.advanceTimersByTime(60);
    swipe.suspend();
    expect(onPreview.mock.calls.at(-1)?.[0]).toBe(0);
    vi.advanceTimersByTime(120);
    expect(swipe.handle(wheel(130))).toBe(true);
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("keeps a committed gesture latched when resize or pointer activity suspends it", () => {
    const { swipe, onCommit } = fixture();
    swipe.handle(wheel(130));
    vi.advanceTimersByTime(60);
    swipe.suspend(false);
    vi.advanceTimersByTime(50);
    expect(swipe.handle(wheel(130))).toBe(false);
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(1);
    vi.advanceTimersByTime(180);
    expect(swipe.handle(wheel(130))).toBe(true);
    expect(onCommit).toHaveBeenCalledTimes(2);
  });

  it("extends the quiet interval when a disabled view observes more wheel input", () => {
    const { swipe, onPreview, onCommit } = fixture();
    swipe.suspend(true);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(100);
    swipe.suspend(true);
    vi.advanceTimersByTime(100);
    expect(swipe.handle(wheel(130))).toBe(false);
    expect(onPreview).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(180);
    expect(swipe.handle(wheel(130))).toBe(true);
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(1);
    swipe.dispose();
    swipe.suspend(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears preview and timers when a popup or another interaction cancels the gesture", () => {
    const { swipe, onPreview, onCommit, onRelease } = fixture();
    swipe.handle(wheel(60));
    swipe.cancel();
    expect(onRelease).toHaveBeenCalledTimes(1);
    expect(onPreview.mock.calls.at(-1)?.[0]).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    swipe.handle(wheel(70));
    expect(onCommit).not.toHaveBeenCalled();
    swipe.dispose();
    expect(vi.getTimerCount()).toBe(0);
    expect(swipe.handle(wheel(400))).toBe(false);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("rejects invalid and empty samples without scheduling navigation", () => {
    const { swipe, onPreview, onCommit } = fixture();
    expect(swipe.handle(wheel(0))).toBe(false);
    expect(swipe.handle(wheel(Number.NaN))).toBe(false);
    expect(swipe.handle(wheel(10, Number.POSITIVE_INFINITY))).toBe(false);
    expect(onPreview).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
