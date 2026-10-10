// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { attachWeekPaging } from "./week_pager";

interface TestAnimation {
  target: Element;
  resolve: () => void;
  cancel: ReturnType<typeof vi.fn>;
}

let animations: TestAnimation[];
let observers: { callback: ResizeObserverCallback; disconnect: ReturnType<typeof vi.fn> }[];
let cleanups: (() => void)[];
let originalAnimate: PropertyDescriptor | undefined;
let reducedMotion: MediaQueryList;

beforeEach(() => {
  vi.useFakeTimers();
  animations = [];
  observers = [];
  cleanups = [];
  const media = new EventTarget();
  Object.defineProperty(media, "matches", { configurable: true, value: false });
  reducedMotion = media as MediaQueryList;
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => reducedMotion),
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      callback: ResizeObserverCallback;
      disconnect = vi.fn();
      observe = vi.fn();
      unobserve = vi.fn();
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
        observers.push(this);
      }
    },
  );
  originalAnimate = Object.getOwnPropertyDescriptor(Element.prototype, "animate");
  Object.defineProperty(Element.prototype, "animate", {
    configurable: true,
    value: vi.fn(function (this: Element) {
      let resolve!: () => void;
      const finished = new Promise<void>((done) => {
        resolve = done;
      });
      const cancel = vi.fn(() => resolve());
      animations.push({ target: this, resolve, cancel });
      return { finished, cancel } as unknown as Animation;
    }),
  });
});

afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  if (originalAnimate) Object.defineProperty(Element.prototype, "animate", originalAnimate);
  else Reflect.deleteProperty(Element.prototype, "animate");
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function fixture() {
  const host = document.createElement("div");
  const scroller = document.createElement("div");
  const button = document.createElement("button");
  button.id = "live-task";
  button.textContent = "Task";
  scroller.id = "live-week";
  scroller.append(button);
  host.append(scroller);
  document.body.append(host);
  let width = 640;
  let disabled = false;
  Object.defineProperties(host, {
    clientWidth: { get: () => width },
    clientHeight: { value: 480 },
  });
  Object.defineProperties(scroller, {
    clientWidth: { value: 620 },
    clientHeight: { value: 460 },
    offsetLeft: { value: 0 },
    offsetTop: { value: 20 },
  });
  scroller.scrollTop = 237;
  const navigate = vi.fn(() => {
    scroller.scrollTop = 0;
  });
  const onPaging = vi.fn();
  const pager = attachWeekPaging({ host, scroller, disabled: () => disabled, navigate, onPaging });
  cleanups.push(() => pager.dispose());
  const wheel = (init: WheelEventInit = {}, target: Element = scroller) => {
    const event = new WheelEvent("wheel", {
      deltaX: 130,
      bubbles: true,
      cancelable: true,
      ...init,
    });
    target.dispatchEvent(event);
    return event;
  };
  const pointer = (type: "pointerdown" | "pointerup", target: Element = button) => {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event;
  };
  return {
    host,
    scroller,
    button,
    navigate,
    onPaging,
    pager,
    wheel,
    pointer,
    disable: (value: boolean) => {
      disabled = value;
    },
    resize: () => {
      width += 100;
      observers[0].callback([], {} as ResizeObserver);
    },
  };
}

async function finishAnimations() {
  for (const animation of animations) animation.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("Planner week paging DOM integration", () => {
  it("prevents horizontal scrolling and navigates once through the whole inertia burst", async () => {
    const view = fixture();
    expect(view.wheel({ deltaX: 60 }).defaultPrevented).toBe(true);
    expect(view.wheel({ deltaX: 70 }).defaultPrevented).toBe(true);
    expect(view.navigate).toHaveBeenCalledExactlyOnceWith(1);
    await finishAnimations();
    for (const deltaX of [80, 45, 20, 5]) {
      vi.advanceTimersByTime(60);
      expect(view.wheel({ deltaX }).defaultPrevented).toBe(true);
    }
    expect(view.navigate).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(181);
    view.wheel({ deltaX: -130 });
    expect(view.navigate.mock.calls).toEqual([[1], [-1]]);
  });

  it("preserves vertical scrolling, pinch zoom and discrete wheel defaults", () => {
    const view = fixture();
    expect(view.wheel({ deltaX: 2, deltaY: 50 }).defaultPrevented).toBe(false);
    vi.advanceTimersByTime(181);
    expect(view.wheel({ ctrlKey: true }).defaultPrevented).toBe(false);
    expect(view.wheel({ deltaMode: WheelEvent.DOM_DELTA_LINE }).defaultPrevented).toBe(false);
    expect(view.navigate).not.toHaveBeenCalled();
    expect(view.scroller.style.transform).toBe("");
  });

  it("keeps the live calendar and vertical position while a noninteractive snapshot departs", async () => {
    const view = fixture();
    view.wheel();
    const snapshot = view.host.querySelector<HTMLElement>(".planner-week-snapshot")!;
    expect(snapshot).not.toBeNull();
    expect(view.host.firstElementChild).toBe(view.scroller);
    expect(view.scroller.scrollTop).toBe(237);
    expect(snapshot.scrollTop).toBe(237);
    expect(snapshot.getAttribute("aria-hidden")).toBe("true");
    expect(snapshot.hasAttribute("inert")).toBe(true);
    expect(snapshot.hasAttribute("id")).toBe(false);
    expect(snapshot.querySelector("[id]")).toBeNull();
    expect(snapshot.querySelector("button")?.tabIndex).toBe(-1);
    expect(view.button.id).toBe("live-task");
    expect(animations.map((animation) => animation.target)).toEqual([snapshot, view.scroller]);
    await finishAnimations();
    expect(view.host.querySelector(".planner-week-snapshot")).toBeNull();
    expect(view.scroller.scrollTop).toBe(237);
    expect(view.scroller.style.willChange).toBe("");
    expect(view.onPaging).toHaveBeenLastCalledWith(false);
  });

  it("does not navigate while disabled, editing a field, or holding a pointer", () => {
    const view = fixture();
    view.disable(true);
    expect(view.wheel().defaultPrevented).toBe(false);
    view.disable(false);
    const input = document.createElement("input");
    view.scroller.append(input);
    expect(view.wheel({}, input).defaultPrevented).toBe(false);
    view.pointer("pointerdown");
    expect(view.wheel().defaultPrevented).toBe(false);
    expect(view.navigate).not.toHaveBeenCalled();
    view.pointer("pointerup");
    vi.advanceTimersByTime(181);
    expect(view.wheel().defaultPrevented).toBe(true);
    expect(view.navigate).toHaveBeenCalledTimes(1);
  });

  it("blocks click and drag initiation until the calendar finishes moving", async () => {
    const view = fixture();
    const click = vi.fn();
    const drag = vi.fn();
    view.button.addEventListener("click", click);
    view.button.addEventListener("pointerdown", drag);
    view.wheel();
    const down = view.pointer("pointerdown");
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    view.button.dispatchEvent(event);
    expect(down.defaultPrevented).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(drag).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
    await finishAnimations();
    view.pointer("pointerdown");
    view.button.click();
    expect(drag).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("suppresses a click released after paging when its pointerdown was blocked during the transition", async () => {
    const view = fixture();
    const selectDate = vi.fn();
    view.button.addEventListener("click", selectDate);
    view.wheel();
    expect(view.pointer("pointerdown").defaultPrevented).toBe(true);
    await finishAnimations();
    expect(view.onPaging).toHaveBeenLastCalledWith(false);
    view.pointer("pointerup");
    const delayedClick = new MouseEvent("click", { bubbles: true, cancelable: true });
    view.button.dispatchEvent(delayedClick);
    expect(delayedClick.defaultPrevented).toBe(true);
    expect(selectDate).not.toHaveBeenCalled();

    view.pointer("pointerdown");
    view.pointer("pointerup");
    view.button.click();
    expect(selectDate).toHaveBeenCalledTimes(1);
  });

  it("clears partial previews on blur and transition snapshots on a size change", async () => {
    const view = fixture();
    view.wheel({ deltaX: 50 });
    expect(view.scroller.style.transform).not.toBe("");
    window.dispatchEvent(new Event("blur"));
    expect(view.scroller.style.transform).toBe("");
    vi.advanceTimersByTime(181);
    expect(vi.getTimerCount()).toBe(0);
    view.wheel();
    view.resize();
    expect(view.host.querySelector(".planner-week-snapshot")).toBeNull();
    expect(animations.every((animation) => animation.cancel.mock.calls.length === 1)).toBe(true);
    expect(view.scroller.style.willChange).toBe("");
    vi.advanceTimersByTime(181);
    expect(vi.getTimerCount()).toBe(0);
    await finishAnimations();
    expect(view.onPaging).toHaveBeenLastCalledWith(false);
  });

  it("does not navigate twice when resizing interrupts the same horizontal inertia burst", () => {
    const view = fixture();
    view.wheel();
    expect(view.navigate).toHaveBeenCalledExactlyOnceWith(1);
    view.resize();
    expect(view.host.querySelector(".planner-week-snapshot")).toBeNull();
    view.wheel();
    expect(view.navigate).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(181);
    view.wheel();
    expect(view.navigate.mock.calls).toEqual([[1], [1]]);
  });

  it("waits for a new burst after receiving a noncancelable horizontal wheel sample", () => {
    const view = fixture();
    expect(view.wheel({ cancelable: false }).defaultPrevented).toBe(false);
    view.wheel({ cancelable: true });
    expect(view.navigate).not.toHaveBeenCalled();
    expect(view.host.querySelector(".planner-week-snapshot")).toBeNull();
    vi.advanceTimersByTime(181);
    expect(view.wheel().defaultPrevented).toBe(true);
    expect(view.navigate).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("disposes active animations and listeners without leaving the live content blocked", async () => {
    const view = fixture();
    view.wheel();
    view.pager.dispose();
    expect(view.host.querySelector(".planner-week-snapshot")).toBeNull();
    expect(observers[0].disconnect).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(view.wheel().defaultPrevented).toBe(false);
    const click = vi.fn();
    view.button.addEventListener("click", click);
    view.button.click();
    expect(click).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event("blur"));
    await finishAnimations();
    expect(view.navigate).toHaveBeenCalledTimes(1);
    expect(view.scroller.style.transform).toBe("");
  });

  it("honors reduced motion with a single navigation and no snapshot or animation", () => {
    Object.defineProperty(reducedMotion, "matches", { value: true });
    const view = fixture();
    expect(view.wheel().defaultPrevented).toBe(true);
    expect(view.wheel().defaultPrevented).toBe(true);
    expect(view.navigate).toHaveBeenCalledExactlyOnceWith(1);
    expect(view.host.querySelector(".planner-week-snapshot")).toBeNull();
    expect(animations).toHaveLength(0);
  });
});
