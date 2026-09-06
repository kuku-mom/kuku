import { createWeekSwipeRecognizer } from "./week_swipe";

export interface WeekPagerOptions {
  host: HTMLElement;
  scroller: HTMLElement;
  disabled: () => boolean;
  navigate: (direction: -1 | 1) => void;
  onOffset?: (offset: number) => void;
  onPaging?: (paging: boolean) => void;
}

/** Keep the live calendar mounted, including its vertical scroll position. Only
 * the departing page is a short-lived, inert snapshot during the transition.
 */
export function attachWeekPaging(options: WeekPagerOptions) {
  const { host, scroller } = options;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let offset = 0;
  let paging = false;
  let pointerHeld = false;
  let blockedClick = false;
  let disposed = false;
  let snapshot: HTMLElement | undefined;
  let animations: Animation[] = [];
  let generation = 0;
  let settling: ReturnType<typeof setTimeout> | undefined;
  const duration = 260;
  const easing = "cubic-bezier(0.2, 0.8, 0.2, 1)";
  const translate = (value: number) => `translate3d(${value}px, 0, 0)`;

  const resetVisuals = () => {
    generation++;
    clearTimeout(settling);
    for (const animation of animations) animation.cancel();
    animations = [];
    snapshot?.remove();
    snapshot = undefined;
    scroller.style.removeProperty("transform");
    scroller.style.removeProperty("transition");
    scroller.style.removeProperty("will-change");
    offset = 0;
    paging = false;
    options.onOffset?.(0);
    options.onPaging?.(false);
  };
  const recognizer = createWeekSwipeRecognizer({
    onPreview(value) {
      if (paging || disposed) return;
      offset = value;
      options.onOffset?.(value);
      if (reducedMotion.matches) return;
      if (value) {
        clearTimeout(settling);
        scroller.style.removeProperty("transition");
        scroller.style.willChange = "transform";
      }
      scroller.style.transform = value ? translate(value) : "";
    },
    onRelease() {
      if (paging || disposed) return;
      scroller.style.transition = reducedMotion.matches ? "" : `transform 180ms ${easing}`;
      clearTimeout(settling);
      settling = setTimeout(resetVisuals, 180);
    },
    onCommit(direction) {
      if (disposed || options.disabled() || pointerHeld) return;
      // Do not reset the recognizer here: it must consume the rest of this
      // gesture's momentum without navigating a second time.
      if (reducedMotion.matches || typeof scroller.animate !== "function") {
        options.navigate(direction);
        resetVisuals();
        return;
      }
      const width = scroller.clientWidth;
      const scrollTop = scroller.scrollTop;
      const from = offset;
      resetVisuals();
      paging = true;
      options.onPaging?.(true);
      const currentGeneration = generation;
      const old = scroller.cloneNode(true) as HTMLElement;
      old.removeAttribute("id");
      old.removeAttribute("style");
      old.classList.add("planner-week-snapshot");
      old.setAttribute("aria-hidden", "true");
      old.setAttribute("inert", "");
      for (const element of old.querySelectorAll("[id]")) element.removeAttribute("id");
      for (const element of old.querySelectorAll<HTMLElement>("button, input, a, [tabindex]"))
        element.tabIndex = -1;
      Object.assign(old.style, {
        left: `${scroller.offsetLeft}px`,
        top: `${scroller.offsetTop}px`,
        width: `${width}px`,
        height: `${scroller.clientHeight}px`,
      });
      snapshot = old;
      host.append(old);
      old.scrollTop = scrollTop;
      options.navigate(direction);
      scroller.scrollTop = scrollTop;
      scroller.style.willChange = "transform";
      const timing: KeyframeAnimationOptions = { duration, easing, fill: "both" };
      animations = [
        old.animate(
          [{ transform: translate(from) }, { transform: translate(-direction * width) }],
          timing,
        ),
        scroller.animate(
          [{ transform: translate(direction * width + from) }, { transform: translate(0) }],
          timing,
        ),
      ];
      void Promise.allSettled(animations.map((animation) => animation.finished)).then(() => {
        if (!disposed && generation === currentGeneration) resetVisuals();
      });
    },
  });
  const cancel = () => {
    // Resize, popovers and manual navigation may interrupt an ongoing swipe.
    // Its remaining momentum must not become a new navigation.
    recognizer.suspend();
    resetVisuals();
  };
  const wheel = (event: WheelEvent) => {
    if (event.defaultPrevented) return;
    if (!event.cancelable) {
      recognizer.suspend(true);
      if (!paging) resetVisuals();
      return;
    }
    const target = event.target instanceof Element ? event.target : undefined;
    if (
      options.disabled() ||
      pointerHeld ||
      target?.closest("input, textarea, select, [contenteditable=true], [role=dialog], [role=menu]")
    ) {
      recognizer.suspend(true);
      resetVisuals();
      return;
    }
    if (recognizer.handle(event)) event.preventDefault();
  };
  const pointerDown = (event: PointerEvent) => {
    if (event.isPrimary === false) return;
    if (paging && host.contains(event.target as Node)) {
      blockedClick = true;
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    blockedClick = false;
    pointerHeld = true;
    cancel();
  };
  const pointerUp = () => {
    pointerHeld = false;
  };
  const click = (event: MouseEvent) => {
    if (!paging && !blockedClick) return;
    blockedClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const blur = () => {
    pointerHeld = false;
    cancel();
  };
  const visibility = () => {
    if (document.hidden) blur();
  };
  let size = `${host.clientWidth}:${host.clientHeight}`;
  const observer = new ResizeObserver(() => {
    const current = `${host.clientWidth}:${host.clientHeight}`;
    if (size !== current) {
      size = current;
      cancel();
    }
  });
  observer.observe(host);
  host.addEventListener("wheel", wheel, { passive: false });
  host.addEventListener("click", click, true);
  window.addEventListener("pointerdown", pointerDown, true);
  window.addEventListener("pointerup", pointerUp, true);
  window.addEventListener("pointercancel", pointerUp, true);
  window.addEventListener("blur", blur);
  document.addEventListener("visibilitychange", visibility);
  reducedMotion.addEventListener("change", cancel);
  return {
    cancel,
    dispose() {
      disposed = true;
      recognizer.dispose();
      resetVisuals();
      observer.disconnect();
      host.removeEventListener("wheel", wheel);
      host.removeEventListener("click", click, true);
      window.removeEventListener("pointerdown", pointerDown, true);
      window.removeEventListener("pointerup", pointerUp, true);
      window.removeEventListener("pointercancel", pointerUp, true);
      window.removeEventListener("blur", blur);
      document.removeEventListener("visibilitychange", visibility);
      reducedMotion.removeEventListener("change", cancel);
    },
  };
}
