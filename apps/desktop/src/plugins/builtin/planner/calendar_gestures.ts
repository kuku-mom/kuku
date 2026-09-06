import { createSignal, onCleanup } from "solid-js";

import { addDays, blockFor, localDate, segmentOnDay } from "./dates";

export const PIXELS_PER_MINUTE = 0.8;
export interface CalendarRange {
  start: string;
  end: string;
  allDay: boolean;
}
export interface DragBlock extends CalendarRange {
  key: string;
  title: string;
}
type Action = "create" | "move" | "start" | "end";
interface Point {
  day: string;
  minute: number;
}
interface Gesture {
  pointerId: number;
  x: number;
  y: number;
  action: Action;
  block?: DragBlock;
  origin?: Point;
  offset: number;
  active: boolean;
  fromList: boolean;
  previousSelect: string;
  previousCursor: string;
  target?: Point;
  dimensions?: Pick<LiftedBlock, "width" | "height" | "offsetX" | "offsetY">;
}
export interface LiftedBlock {
  x: number;
  y: number;
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
  key: string;
  title: string;
  phase: "dragging" | "settling";
  overCalendar: boolean;
}
function civilDays(end: string, start: string) {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000);
}
function sameRange(a: CalendarRange, b: CalendarRange) {
  return (
    a.allDay === b.allDay &&
    (a.allDay
      ? a.start === b.start && a.end === b.end
      : Date.parse(a.start) === Date.parse(b.start) && Date.parse(a.end) === Date.parse(b.end))
  );
}
/** Pixels per second; slower near the inner edge, independent of display refresh rate. */
export function edgeVelocity(
  position: number,
  start: number,
  end: number,
  zone: number,
  maximum: number,
) {
  const band = Math.min(zone, Math.max(0, (end - start) / 2));
  if (!band) return 0;
  if (position < start + band) return -maximum * Math.min(1, (start + band - position) / band);
  if (position > end - band) return maximum * Math.min(1, (position - end + band) / band);
  return 0;
}
function instantAt(point: Point): string {
  const day = addDays(point.day, Math.floor(point.minute / 1440));
  const minute = ((point.minute % 1440) + 1440) % 1440;
  return blockFor(day, minute, 15).scheduledStart;
}

export function rangeFromPoints(origin: Point, target: Point, selected = true): CalendarRange {
  const a = instantAt(origin);
  const b = instantAt(target);
  const first = Math.min(Date.parse(a), Date.parse(b));
  const last = selected ? Math.max(Date.parse(a), Date.parse(b)) : first;
  return {
    start: new Date(first).toISOString(),
    end: new Date(Math.max(first + 15 * 60000, last + (selected ? 0 : 30 * 60000))).toISOString(),
    allDay: false,
  };
}
export function movedRange(block: DragBlock, point: Point, offset: number): CalendarRange {
  if (block.allDay) {
    const days = Math.max(1, civilDays(block.end, block.start));
    const start = addDays(point.day, -offset);
    return { start, end: addDays(start, days), allDay: true };
  }
  const duration = (Date.parse(block.end) - Date.parse(block.start)) / 60000;
  const start = instantAt({ day: point.day, minute: point.minute - offset });
  return {
    start,
    end: new Date(Date.parse(start) + duration * 60000).toISOString(),
    allDay: false,
  };
}
export function resizedRange(block: DragBlock, point: Point, edge: "start" | "end"): CalendarRange {
  const time = Date.parse(instantAt(point));
  return {
    start:
      edge === "start"
        ? new Date(Math.min(time, Date.parse(block.end) - 15 * 60000)).toISOString()
        : block.start,
    end:
      edge === "end"
        ? new Date(Math.max(time, Date.parse(block.start) + 15 * 60000)).toISOString()
        : block.end,
    allDay: false,
  };
}

/** A single pointer pipeline for list drops, calendar moves, resizing and range creation. */
export function createCalendarGestures(callbacks: {
  create: (range: CalendarRange, anchor?: { x: number; y: number }) => void;
  commit: (block: DragBlock, range: CalendarRange) => Promise<unknown> | void;
  error: (error: unknown) => void;
}) {
  const [preview, setPreview] = createSignal<CalendarRange & { title: string; key?: string }>();
  const [lifted, setLifted] = createSignal<LiftedBlock>();
  const [busyKey, setBusyKey] = createSignal<string>();
  let host: HTMLElement | undefined;
  let scroller: HTMLElement | undefined;
  let gesture: Gesture | undefined;
  let frame = 0,
    frameTime = 0;
  let lastX = 0,
    lastY = 0;
  let suppressUntil = 0;
  let settlement: ReturnType<typeof setTimeout> | undefined;
  let revision = 0;
  let disposed = false;
  let commitPending = false;

  const gridTop = () => {
    if (!scroller) return 0;
    const allDay = host?.querySelector<HTMLElement>("[data-planner-all-day-row], .planner-all-day");
    const headings = host?.querySelector<HTMLElement>(".planner-day-headings");
    return Math.max(
      scroller.getBoundingClientRect().top,
      allDay?.getBoundingClientRect().bottom ?? 0,
      headings?.getBoundingClientRect().bottom ?? 0,
    );
  };
  const pointAt = (x: number, y: number, allDay = gesture?.block?.allDay): Point | undefined => {
    if (!host || !scroller) return;
    const visible = scroller.getBoundingClientRect();
    if (
      x < visible.left ||
      x >= visible.right ||
      y < visible.top ||
      y > visible.bottom ||
      (!allDay && y < gridTop())
    )
      return;
    for (const column of host.querySelectorAll<HTMLElement>(
      ".planner-day-column[data-planner-day]",
    )) {
      const rect = column.getBoundingClientRect();
      if (x >= rect.left && x < rect.right && column.dataset.plannerDay) {
        if (!allDay && y < rect.top) return;
        return {
          day: column.dataset.plannerDay,
          minute: Math.max(0, Math.min(1440, (y - rect.top) / PIXELS_PER_MINUTE)),
        };
      }
    }
  };
  const compute = () => {
    const current = gesture;
    if (!current) return;
    const point = pointAt(lastX, lastY);
    if (!point) {
      current.target = undefined;
      setPreview(undefined);
      return;
    }
    current.target = point;
    try {
      let range =
        current.action === "create"
          ? rangeFromPoints(current.origin!, point, current.active)
          : current.action === "move"
            ? movedRange(current.block!, point, current.offset)
            : resizedRange(current.block!, point, current.action);
      // A horizontal lift, or returning to the original slot, is not an edit.
      // Preserve existing provider times that do not happen to lie on our grid.
      if (
        current.action === "move" &&
        !current.fromList &&
        current.origin?.day === point.day &&
        Math.round((point.minute - current.origin.minute) / 15) === 0
      )
        range = current.block!;
      setPreview((previous) =>
        previous && sameRange(previous, range) && previous.key === current.block?.key
          ? previous
          : { ...range, title: current.block?.title ?? "", key: current.block?.key },
      );
    } catch {
      setPreview(undefined);
    }
  };
  const motionFrame = (time: number) => {
    frame = 0;
    const current = gesture;
    if (!current?.active) return;
    const elapsed = frameTime ? Math.min(40, time - frameTime) : 1000 / 60;
    frameTime = time;
    let scrolling = false;
    if (scroller) {
      const rect = scroller.getBoundingClientRect();
      if (
        lastX >= rect.left - 32 &&
        lastX <= rect.right + 32 &&
        lastY >= rect.top - 32 &&
        lastY <= rect.bottom + 32
      ) {
        const vx = edgeVelocity(lastX, rect.left, rect.right, 44, 540);
        const vy = current.block?.allDay ? 0 : edgeVelocity(lastY, gridTop(), rect.bottom, 56, 780);
        const beforeX = scroller.scrollLeft,
          beforeY = scroller.scrollTop;
        scroller.scrollLeft += (vx * elapsed) / 1000;
        scroller.scrollTop += (vy * elapsed) / 1000;
        scrolling = scroller.scrollLeft !== beforeX || scroller.scrollTop !== beforeY;
      }
    }
    compute();
    updateLift(current);
    if (scrolling) frame = requestAnimationFrame(motionFrame);
    else frameTime = 0;
  };
  const scheduleFrame = () => {
    if (!frame) frame = requestAnimationFrame(motionFrame);
  };
  const scroll = () => {
    if (gesture?.active) scheduleFrame();
  };
  const removeListeners = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", abort);
    window.removeEventListener("keydown", key);
    window.removeEventListener("blur", abort);
    window.removeEventListener("scroll", scroll, true);
  };
  const releasePointer = () => {
    if (gesture) {
      document.body.style.userSelect = gesture.previousSelect;
      document.body.style.cursor = gesture.previousCursor;
    }
    gesture = undefined;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    frameTime = 0;
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("scroll", scroll, true);
  };
  const clear = () => {
    revision++;
    releasePointer();
    removeListeners();
    if (settlement) clearTimeout(settlement);
    settlement = undefined;
    setPreview(undefined);
    setLifted(undefined);
    if (!commitPending) setBusyKey(undefined);
  };
  const abort = (event?: Event) => {
    if (event && "pointerId" in event && gesture && event.pointerId !== gesture.pointerId) return;
    if (gesture?.active) suppressUntil = Date.now() + 300;
    clear();
    // A dispatched write cannot be undone by Escape. Keep its busy key until
    // completion, while removing every pointer listener and visual immediately.
  };
  const key = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      abort();
    }
  };
  const move = (event: PointerEvent) => {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    lastX = event.clientX;
    lastY = event.clientY;
    if (!gesture.active && Math.hypot(lastX - gesture.x, lastY - gesture.y) >= 5) {
      gesture.active = true;
      document.body.style.userSelect = "none";
      document.body.style.cursor =
        gesture.action === "move"
          ? "grabbing"
          : gesture.action === "create"
            ? "default"
            : "ns-resize";
    }
    if (gesture.active) {
      event.preventDefault();
      scheduleFrame();
    }
  };
  const targetBounds = (current: Gesture, range: CalendarRange) => {
    if (!host) return;
    const day =
      current.target?.day ?? (range.allDay ? range.start : localDate(new Date(range.start)));
    const column = [
      ...host.querySelectorAll<HTMLElement>(".planner-day-column[data-planner-day]"),
    ].find((element) => element.dataset.plannerDay === day);
    const guides = [...host.querySelectorAll<HTMLElement>("[data-planner-drop-preview]")];
    const guide = guides.find((element) => {
      const bounds = element.getBoundingClientRect();
      return (
        bounds.width > 0 &&
        bounds.height > 0 &&
        (!element.dataset.plannerKey || element.dataset.plannerKey === current.block?.key) &&
        (element.dataset.plannerDay
          ? element.dataset.plannerDay === day
          : !column ||
            (bounds.left >= column.getBoundingClientRect().left - 1 &&
              bounds.left < column.getBoundingClientRect().right))
      );
    });
    let target = guide?.getBoundingClientRect();
    if (!target && column && !range.allDay) {
      const segment = segmentOnDay(range.start, range.end, day),
        bounds = column.getBoundingClientRect();
      if (segment)
        target = {
          left: bounds.left + 2,
          top: bounds.top + segment.top * PIXELS_PER_MINUTE,
          width: Math.max(1, bounds.width - 4),
          height: Math.max(15, segment.height) * PIXELS_PER_MINUTE,
        } as DOMRect;
    }
    return target;
  };
  const updateLift = (current: Gesture) => {
    if (current.action !== "move" || !current.block || !current.dimensions) return;
    const original = current.dimensions;
    const range = preview();
    const target = range ? targetBounds(current, range) : undefined;
    const width = target?.width ?? original.width;
    const height = target?.height ?? original.height;
    const next: LiftedBlock = {
      x: lastX,
      y: lastY,
      width,
      height,
      offsetX: (original.offsetX / original.width) * width,
      offsetY: (original.offsetY / original.height) * height,
      key: current.block.key,
      title: current.block.title,
      phase: "dragging",
      overCalendar: !!range,
    };
    setLifted((previous) =>
      previous?.x === next.x &&
      previous.y === next.y &&
      previous.width === next.width &&
      previous.height === next.height &&
      previous.offsetX === next.offsetX &&
      previous.offsetY === next.offsetY &&
      previous.overCalendar === next.overCalendar &&
      previous.phase === next.phase
        ? previous
        : next,
    );
  };
  const settleCard = (current: Gesture, range: CalendarRange) => {
    const floating = lifted();
    if (!floating) return;
    const target = targetBounds(current, range);
    setLifted({
      ...floating,
      ...(target
        ? {
            x: target.left,
            y: target.top,
            width: target.width,
            height: target.height,
            offsetX: 0,
            offsetY: 0,
          }
        : {}),
      phase: "settling",
      overCalendar: true,
    });
  };
  const finishCommit = async (current: Gesture, result: CalendarRange) => {
    const id = revision;
    commitPending = true;
    setBusyKey(current.block!.key);
    settleCard(current, result);
    try {
      await callbacks.commit(current.block!, result);
      commitPending = false;
      if (!disposed && id === revision) {
        settlement = setTimeout(() => {
          clear();
          setBusyKey(undefined);
        }, 140);
      } else setBusyKey(undefined);
    } catch (error) {
      commitPending = false;
      if (id === revision) clear();
      setBusyKey(undefined);
      if (!disposed) callbacks.error(error);
    }
  };
  const up = (event: PointerEvent) => {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    lastX = event.clientX;
    lastY = event.clientY;
    const current = gesture;
    if (current.active || current.action === "create") compute();
    if (current.active) updateLift(current);
    const result = preview();
    if (current.active || current.action === "create") {
      event.preventDefault();
      suppressUntil = Date.now() + 300;
    }
    releasePointer();
    if (!result || (!current.active && current.action !== "create")) {
      clear();
      return;
    }
    if (current.action === "create") {
      clear();
      try {
        callbacks.create(result, { x: event.clientX, y: event.clientY });
      } catch (error) {
        callbacks.error(error);
      }
    } else if (!current.fromList && sameRange(current.block!, result)) clear();
    else void finishCommit(current, result);
  };
  const swallowClick = (event: MouseEvent) => {
    if (event.detail && Date.now() < suppressUntil) {
      event.preventDefault();
      event.stopImmediatePropagation();
      suppressUntil = 0;
    }
  };
  window.addEventListener("click", swallowClick, true);
  onCleanup(() => {
    disposed = true;
    clear();
    setBusyKey(undefined);
    window.removeEventListener("click", swallowClick, true);
  });
  return {
    preview,
    lifted,
    busyKey,
    register(element: HTMLElement, scrollElement: HTMLElement) {
      host = element;
      scroller = scrollElement;
    },
    begin(event: PointerEvent, action: Action, block?: DragBlock, fromList = false) {
      if (disposed || event.button !== 0 || event.isPrimary === false || gesture || commitPending)
        return;
      if (busyKey()) clear();
      const origin = pointAt(event.clientX, event.clientY, block?.allDay);
      if ((action === "create" && !origin) || (action !== "create" && !block)) return;
      let offset = 0;
      if (block && !fromList && origin) {
        const start = new Date(block.start);
        const days = civilDays(origin.day, block.allDay ? block.start : localDate(start));
        offset = block.allDay
          ? days
          : days * 1440 +
            origin.minute -
            start.getHours() * 60 -
            start.getMinutes() -
            start.getSeconds() / 60;
      }
      const target =
        event.target instanceof Element
          ? event.target
          : event.currentTarget instanceof Element
            ? event.currentTarget
            : undefined;
      const source = target?.closest<HTMLElement>(
        "[data-planner-drag-source], .planner-block, .planner-task-row, .planner-task, .planner-all-day-event",
      );
      const bounds = source?.getBoundingClientRect();
      const dimensions =
        block && bounds && bounds.width > 0 && bounds.height > 0
          ? {
              width: bounds.width,
              height: bounds.height,
              offsetX: Math.max(0, Math.min(bounds.width, event.clientX - bounds.left)),
              offsetY: Math.max(0, Math.min(bounds.height, event.clientY - bounds.top)),
            }
          : block
            ? { width: 200, height: 40, offsetX: 16, offsetY: 20 }
            : undefined;
      gesture = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        action,
        block,
        origin,
        offset,
        active: false,
        fromList,
        dimensions,
        previousSelect: document.body.style.userSelect,
        previousCursor: document.body.style.cursor,
      };
      lastX = event.clientX;
      lastY = event.clientY;
      window.addEventListener("pointermove", move, { passive: false });
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", abort);
      window.addEventListener("keydown", key);
      window.addEventListener("blur", abort);
      window.addEventListener("scroll", scroll, { capture: true, passive: true });
    },
  };
}
export type CalendarGestures = ReturnType<typeof createCalendarGestures>;
