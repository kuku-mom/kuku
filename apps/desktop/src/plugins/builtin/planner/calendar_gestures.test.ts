// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "solid-js";

import {
  createCalendarGestures,
  edgeVelocity,
  movedRange,
  rangeFromPoints,
  resizedRange,
  type CalendarRange,
  type DragBlock,
} from "./calendar_gestures";
import { dateTimeInput, localDateTimeToISO } from "./dates";

const iso = (value: string) => localDateTimeToISO(value)!;
describe("calendar pointer time arithmetic", () => {
  it("scales edge velocity continuously with distance", () => {
    expect(edgeVelocity(50, 0, 700, 50, 600)).toBe(0);
    expect(edgeVelocity(25, 0, 700, 50, 600)).toBe(-300);
    expect(edgeVelocity(0, 0, 700, 50, 600)).toBe(-600);
    expect(edgeVelocity(675, 0, 700, 50, 600)).toBe(300);
    expect(edgeVelocity(1000, 0, 700, 50, 600)).toBe(600);
  });
  it("creates a 30 minute click or a backwards selected interval", () => {
    const clicked = rangeFromPoints(
      { day: "2026-09-04", minute: 540 },
      { day: "2026-09-04", minute: 540 },
      false,
    );
    expect(dateTimeInput(clicked.end)).toBe("2026-09-04T09:30");
    const dragged = rangeFromPoints(
      { day: "2026-09-04", minute: 600 },
      { day: "2026-09-04", minute: 540 },
    );
    expect(dateTimeInput(dragged.start)).toBe("2026-09-04T09:00");
    expect(dateTimeInput(dragged.end)).toBe("2026-09-04T10:00");
  });
  it("retains the grabbed position while moving a block across midnight", () => {
    const block: DragBlock = {
      key: "a",
      title: "late",
      start: iso("2026-09-04T23:00"),
      end: iso("2026-09-05T02:00"),
      allDay: false,
    };
    const result = movedRange(block, { day: "2026-09-06", minute: 30 }, 90);
    expect(dateTimeInput(result.start)).toBe("2026-09-05T23:00");
    expect(dateTimeInput(result.end)).toBe("2026-09-06T02:00");
  });
  it("resizes to midnight and prevents crossing the opposite edge", () => {
    const block: DragBlock = {
      key: "a",
      title: "work",
      start: iso("2026-09-04T23:00"),
      end: iso("2026-09-04T23:30"),
      allDay: false,
    };
    expect(dateTimeInput(resizedRange(block, { day: "2026-09-04", minute: 1440 }, "end").end)).toBe(
      "2026-09-05T00:00",
    );
    const start = resizedRange(block, { day: "2026-09-05", minute: 60 }, "start");
    expect(Date.parse(start.end) - Date.parse(start.start)).toBe(15 * 60000);
  });
  it("moves all-day events with an exclusive end date", () => {
    const result = movedRange(
      { key: "a", title: "trip", start: "2026-09-04", end: "2026-09-07", allDay: true },
      { day: "2026-09-10", minute: 0 },
      0,
    );
    expect(result).toEqual({ start: "2026-09-10", end: "2026-09-13", allDay: true });
  });
});

describe("calendar pointer lifecycle", () => {
  let dispose: () => void;
  let frames: Map<number, FrameRequestCallback>;
  let nextFrame: number;
  let now: number;
  let controller: ReturnType<typeof createCalendarGestures>;
  let host: HTMLElement;
  let scroller: HTMLElement;
  let source: HTMLElement;
  let headerBottom: number;
  let commit: ReturnType<
    typeof vi.fn<(block: DragBlock, range: CalendarRange) => Promise<unknown> | void>
  >;
  let create: ReturnType<
    typeof vi.fn<(range: CalendarRange, anchor?: { x: number; y: number }) => void>
  >;
  let error: ReturnType<typeof vi.fn<(error: unknown) => void>>;
  const rectangle = (left: number, top: number, width: number, height: number) =>
    ({
      left,
      top,
      right: left + width,
      bottom: top + height,
      width,
      height,
      x: left,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect;
  const block = (): DragBlock => ({
    key: "task:one",
    title: "Write",
    start: iso("2026-09-04T09:00"),
    end: iso("2026-09-04T10:00"),
    allDay: false,
  });
  const pointer = (type: string, x: number, y: number, id = 1) => {
    const event = new MouseEvent(type, {
      clientX: x,
      clientY: y,
      button: 0,
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(event, "pointerId", { value: id });
    return event as PointerEvent;
  };
  const start = (
    x = 150,
    y = 156,
    action: "move" | "start" | "end" | "create" = "move",
    fromList = false,
    selected = block(),
  ) => {
    const event = pointer("pointerdown", x, y);
    Object.defineProperty(event, "target", { value: source });
    controller.begin(event, action, action === "create" ? undefined : selected, fromList);
  };
  const move = (x: number, y: number, id = 1) =>
    window.dispatchEvent(pointer("pointermove", x, y, id));
  const up = (x: number, y: number) => window.dispatchEvent(pointer("pointerup", x, y));
  const tick = (elapsed = 1000 / 60) => {
    now += elapsed;
    const queued = [...frames.values()];
    frames.clear();
    for (const callback of queued) callback(now);
  };
  beforeEach(() => {
    vi.useFakeTimers();
    frames = new Map();
    nextFrame = 0;
    now = 0;
    headerBottom = 80;
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        frames.set(++nextFrame, callback);
        return nextFrame;
      }),
    );
    vi.stubGlobal(
      "cancelAnimationFrame",
      vi.fn((id: number) => {
        frames.delete(id);
      }),
    );
    document.body.innerHTML = "";
    document.body.style.userSelect = "text";
    document.body.style.cursor = "auto";
    host = document.createElement("div");
    scroller = document.createElement("div");
    host.append(scroller);
    scroller.getBoundingClientRect = () => rectangle(100, 0, 300, 700);
    let scrollY = 388,
      scrollX = 0;
    Object.defineProperties(scroller, {
      scrollTop: {
        get: () => scrollY,
        set: (value) => {
          scrollY = Math.max(0, Math.min(600, value));
        },
      },
      scrollLeft: {
        get: () => scrollX,
        set: (value) => {
          scrollX = Math.max(0, Math.min(300, value));
        },
      },
    });
    const header = document.createElement("div");
    header.className = "planner-all-day";
    header.getBoundingClientRect = () => rectangle(100, 0, 300, headerBottom);
    scroller.append(header);
    for (const [index, day] of ["2026-09-04", "2026-09-05", "2026-09-06"].entries()) {
      const column = document.createElement("div");
      column.className = "planner-day-column";
      column.dataset.plannerDay = day;
      column.getBoundingClientRect = () =>
        rectangle(100 + index * 100 - scrollX, 100 - scrollY, 100, 1152);
      scroller.append(column);
    }
    source = document.createElement("div");
    source.className = "planner-block";
    source.dataset.plannerDragSource = "";
    source.getBoundingClientRect = () => rectangle(102, 144, 96, 48);
    document.body.append(host, source);
    commit = vi.fn();
    create = vi.fn();
    error = vi.fn();
    createRoot((cleanup) => {
      dispose = cleanup;
      controller = createCalendarGestures({ commit, create, error });
    });
    controller.register(host, scroller);
  });
  afterEach(() => {
    dispose();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });
  it("preserves click below threshold and ignores another pointer", () => {
    start();
    move(300, 250, 2);
    move(152, 158);
    up(152, 158);
    expect(commit).not.toHaveBeenCalled();
    expect(controller.lifted()).toBeUndefined();
    const click = new MouseEvent("click", { detail: 1, cancelable: true });
    window.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(false);
    expect(document.body.style.userSelect).toBe("text");
  });
  it("coalesces motion per frame and carries a list card outside the grid", () => {
    source.className = "planner-task";
    source.getBoundingClientRect = () => rectangle(0, 100, 90, 40);
    start(45, 120, "move", true);
    move(52, 130);
    move(65, 140);
    move(75, 145);
    expect(frames.size).toBe(1);
    expect(controller.lifted()).toBeUndefined();
    tick();
    expect(controller.lifted()).toMatchObject({
      x: 75,
      y: 145,
      width: 90,
      height: 40,
      offsetX: 45,
      offsetY: 20,
      phase: "dragging",
    });
    expect(controller.preview()).toBeUndefined();
    expect(document.body.style.cursor).toBe("grabbing");
    move(160, 200);
    tick();
    expect(controller.lifted()?.x).toBe(160);
    expect(controller.preview()).toBeDefined();
  });
  it("fits the calendar segment on entry and restores the original grab geometry on leave", () => {
    source.className = "planner-task";
    source.getBoundingClientRect = () => rectangle(0, 100, 240, 60);
    start(45, 120, "move", true);
    move(75, 145);
    tick();
    expect(controller.lifted()).toMatchObject({
      width: 240,
      height: 60,
      offsetX: 45,
      offsetY: 20,
      overCalendar: false,
    });
    move(160, 200);
    tick();
    expect(controller.lifted()).toMatchObject({
      x: 160,
      y: 200,
      width: 96,
      height: 48,
      offsetX: 18,
      offsetY: 16,
      overCalendar: true,
    });
    move(75, 200);
    tick();
    expect(controller.lifted()).toMatchObject({
      x: 75,
      y: 200,
      width: 240,
      height: 60,
      offsetX: 45,
      offsetY: 20,
      overCalendar: false,
    });
  });
  it("uses the current preview lane on each crossing without accumulating scaled offsets", () => {
    source.className = "planner-task";
    source.getBoundingClientRect = () => rectangle(0, 100, 240, 60);
    for (const [day, width] of [
      ["2026-09-04", 46],
      ["2026-09-05", 96],
    ] as const) {
      const guide = document.createElement("div");
      guide.dataset.plannerDropPreview = "";
      guide.dataset.plannerDay = day;
      guide.dataset.plannerKey = "task:one";
      guide.getBoundingClientRect = () =>
        controller.preview() && dateTimeInput(controller.preview()!.start).startsWith(day)
          ? rectangle(day.endsWith("04") ? 152 : 202, 200, width, 48)
          : rectangle(0, 0, 0, 0);
      host.append(guide);
    }
    start(45, 120, "move", true);
    move(160, 200);
    tick();
    expect(controller.lifted()).toMatchObject({
      width: 46,
      offsetX: (45 / 240) * 46,
      offsetY: 16,
      overCalendar: true,
    });
    move(260, 200);
    tick();
    expect(controller.lifted()).toMatchObject({
      width: 96,
      offsetX: 18,
      offsetY: 16,
      overCalendar: true,
    });
    move(160, 200);
    tick();
    expect(controller.lifted()).toMatchObject({
      width: 46,
      offsetX: (45 / 240) * 46,
      offsetY: 16,
      overCalendar: true,
    });
    up(160, 200);
    expect(controller.lifted()).toMatchObject({
      width: 46,
      height: 48,
      overCalendar: true,
      phase: "settling",
    });
  });
  it("refreshes hover geometry at a stationary pointer when scrolling changes the target", () => {
    source.className = "planner-task";
    source.getBoundingClientRect = () => rectangle(0, 100, 240, 60);
    const guide = document.createElement("div");
    guide.dataset.plannerDropPreview = "";
    guide.dataset.plannerDay = "2026-09-04";
    guide.dataset.plannerKey = "task:one";
    guide.getBoundingClientRect = () => rectangle(152, 200, 46, 48);
    host.append(guide);
    start(45, 120, "move", true);
    move(160, 200);
    tick();
    expect(controller.lifted()?.width).toBe(46);
    scroller.scrollLeft = 80;
    scroller.dispatchEvent(new Event("scroll"));
    tick();
    expect(controller.lifted()).toMatchObject({
      x: 160,
      y: 200,
      width: 96,
      offsetX: 18,
      overCalendar: true,
    });
    headerBottom = 250;
    scroller.dispatchEvent(new Event("scroll"));
    tick();
    expect(controller.lifted()).toMatchObject({
      x: 160,
      y: 200,
      width: 240,
      height: 60,
      offsetX: 45,
      offsetY: 20,
      overCalendar: false,
    });
  });
  it("preserves the raw grab offset and suppresses a move back to the same slot", () => {
    start(150, 151);
    move(160, 154);
    tick();
    expect(controller.preview()?.start).toBe(block().start);
    up(160, 154);
    expect(commit).not.toHaveBeenCalled();
    expect(controller.lifted()).toBeUndefined();
    const click = new MouseEvent("click", { detail: 1, cancelable: true });
    window.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    start(150, 151);
    move(250, 199);
    tick();
    up(250, 199);
    expect(dateTimeInput(commit.mock.calls[0][1].start)).toBe("2026-09-05T10:00");
  });
  it("retains preview during save and lands at the actual overlap preview rectangle", async () => {
    let resolve!: () => void;
    commit.mockImplementation(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    const guide = document.createElement("div");
    guide.dataset.plannerDropPreview = "";
    guide.dataset.plannerDay = "2026-09-05";
    guide.dataset.plannerKey = "task:one";
    guide.getBoundingClientRect = () => rectangle(252, 192, 46, 48);
    host.append(guide);
    start();
    move(260, 204);
    tick();
    up(260, 204);
    expect(controller.busyKey()).toBe("task:one");
    expect(controller.preview()).toBeDefined();
    expect(controller.lifted()).toMatchObject({
      x: 252,
      y: 192,
      width: 46,
      height: 48,
      offsetX: 0,
      offsetY: 0,
      phase: "settling",
    });
    expect(document.body.style.cursor).toBe("auto");
    resolve();
    await Promise.resolve();
    vi.advanceTimersByTime(139);
    expect(controller.preview()).toBeDefined();
    vi.advanceTimersByTime(1);
    expect(controller.lifted()).toBeUndefined();
    expect(controller.preview()).toBeUndefined();
    expect(controller.busyKey()).toBeUndefined();
  });
  it("cleans up rejected saves and reports the error once", async () => {
    const failure = new Error("Connection unavailable");
    commit.mockRejectedValue(failure);
    start();
    move(250, 180);
    tick();
    up(250, 180);
    await Promise.resolve();
    expect(error).toHaveBeenCalledExactlyOnceWith(failure);
    expect(controller.preview()).toBeUndefined();
    expect(controller.busyKey()).toBeUndefined();
    expect(frames.size).toBe(0);
  });
  it.each(["Escape", "pointercancel", "blur"])(
    "cleans listeners and restores selection on %s",
    (cancel) => {
      start();
      move(260, 190);
      tick();
      if (cancel === "Escape")
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
      else
        window.dispatchEvent(
          cancel === "pointercancel" ? pointer(cancel, 260, 190) : new Event("blur"),
        );
      move(290, 300);
      up(290, 300);
      expect(commit).not.toHaveBeenCalled();
      expect(controller.preview()).toBeUndefined();
      expect(controller.lifted()).toBeUndefined();
      expect(document.body.style.userSelect).toBe("text");
      expect(document.body.style.cursor).toBe("auto");
      expect(frames.size).toBe(0);
    },
  );
  it("does not interpret an expanded sticky header as a timed drop target", () => {
    headerBottom = 180;
    start(50, 120, "move", true);
    move(250, 160);
    tick();
    expect(controller.lifted()).toBeDefined();
    expect(controller.preview()).toBeUndefined();
    move(250, 250);
    tick();
    expect(controller.preview()).toBeDefined();
  });
  it("scrolls proportionally near the edge and stops every frame after cancel", () => {
    start();
    move(250, 660);
    tick();
    const inner = scroller.scrollTop;
    move(250, 695);
    tick();
    expect(scroller.scrollTop - inner).toBeGreaterThan(inner - 388);
    expect(frames.size).toBe(1);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(frames.size).toBe(0);
  });
  it("creates from a click using the release anchor without dispatching a move", () => {
    start(150, 240, "create");
    up(150, 240);
    expect(create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ allDay: false }), {
      x: 150,
      y: 240,
    });
    const range = create.mock.calls[0][0] as CalendarRange;
    expect(Date.parse(range.end) - Date.parse(range.start)).toBe(30 * 60000);
    expect(commit).not.toHaveBeenCalled();
  });
  it("keeps a dispatched save busy after Escape without leaving visual or listener state", async () => {
    let resolve!: () => void;
    commit.mockImplementation(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    start();
    move(250, 200);
    tick();
    up(250, 200);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(controller.preview()).toBeUndefined();
    expect(controller.lifted()).toBeUndefined();
    expect(controller.busyKey()).toBe("task:one");
    resolve();
    await Promise.resolve();
    expect(controller.busyKey()).toBeUndefined();
  });
  it("allows a new gesture after Escape interrupts the successful settlement animation", async () => {
    start();
    move(250, 200);
    tick();
    up(250, 200);
    await Promise.resolve();
    expect(controller.busyKey()).toBe("task:one");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(controller.busyKey()).toBeUndefined();
    start();
    move(170, 170);
    tick();
    expect(controller.lifted()?.phase).toBe("dragging");
  });
  it("starts the next pickup immediately during successful visual settlement", async () => {
    start();
    move(250, 200);
    tick();
    up(250, 200);
    await Promise.resolve();
    expect(controller.lifted()?.phase).toBe("settling");
    start();
    move(170, 180);
    tick();
    expect(controller.busyKey()).toBeUndefined();
    expect(controller.lifted()?.phase).toBe("dragging");
    vi.advanceTimersByTime(140);
    expect(controller.lifted()?.phase).toBe("dragging");
    up(170, 180);
    expect(commit).toHaveBeenCalledTimes(2);
  });
});
