import { createEffect, onCleanup, onMount, type JSX } from "solid-js";
import { Portal } from "solid-js/web";

import { placeComposer, type ComposerRect } from "./composer_placement";
import { pt } from "./messages";
import { PlannerGlyph } from "./icons";

export interface PopoverAnchor {
  x: number;
  y: number;
}
export interface ComposerContext {
  scope: HTMLElement;
  target: () => ComposerRect | undefined;
  reserveSpace: (height: number) => void;
}

export function Modal(props: {
  title: string;
  close: () => void;
  children: JSX.Element;
  anchor?: PopoverAnchor;
  composer?: ComposerContext;
}) {
  let dialog!: HTMLDialogElement;
  let body!: HTMLDivElement;
  let refresh = () => {};
  // A changed date or duration can move the preview without resizing the window.
  createEffect(() => {
    props.composer?.target();
    refresh();
  });
  onMount(() => {
    let focusFrame = 0;
    const focusTitle = () => {
      focusFrame = requestAnimationFrame(() => {
        if (!dialog.open) return;
        dialog
          .querySelector<HTMLElement>("[autofocus], input[required]")
          ?.focus({ preventScroll: true });
      });
    };
    onCleanup(() => cancelAnimationFrame(focusFrame));
    if (!props.anchor) {
      dialog.showModal();
      focusTitle();
      return;
    }
    dialog.show();
    let placeFrame = 0;
    let revealFrame = 0;
    let reserved = -1;
    let initial = true;
    let stopped = false;
    const scope = props.composer?.scope;
    const bounds = (): ComposerRect => {
      const rect = scope?.getBoundingClientRect();
      return {
        left: Math.max(0, rect?.left ?? 0),
        top: Math.max(0, rect?.top ?? 0),
        right: Math.min(window.innerWidth, rect?.right ?? window.innerWidth),
        bottom: Math.min(window.innerHeight, rect?.bottom ?? window.innerHeight),
      };
    };
    const target = (): ComposerRect =>
      props.composer?.target() ?? {
        left: props.anchor!.x - 4,
        right: props.anchor!.x + 4,
        top: props.anchor!.y,
        bottom: props.anchor!.y + 24,
      };
    const revealTarget = () => {
      const scroller = scope?.querySelector<HTMLElement>(".planner-week-scroll");
      if (!scroller) return;
      const selected = target();
      const viewport = scroller.getBoundingClientRect();
      const allDay = scroller
        .querySelector<HTMLElement>(".planner-all-day")
        ?.getBoundingClientRect();
      // Only adjust after opening/reserving space. Manual calendar scrolling stays free.
      const top = Math.max(viewport.top, allDay?.bottom ?? viewport.top) + 12;
      const bottom = viewport.bottom - 12;
      if (bottom <= top) return;
      if (allDay && selected.top >= allDay.top && selected.bottom <= allDay.bottom) return;
      if (
        selected.top < top ||
        selected.top + Math.min(24, selected.bottom - selected.top) > bottom
      )
        scroller.scrollTop += selected.top - top;
    };
    const place = () => {
      if (stopped || !dialog.open) return;
      const position = placeComposer(bounds(), target(), {
        width: 360,
        height: body.scrollHeight + 2,
      });
      dialog.dataset.placement = position.placement;
      dialog.style.left = `${position.left}px`;
      dialog.style.top = `${position.top}px`;
      dialog.style.width = `${position.width}px`;
      dialog.style.maxHeight = `${position.maxHeight}px`;
      const changed = reserved !== position.reservedHeight;
      if (changed) {
        reserved = position.reservedHeight;
        props.composer?.reserveSpace(reserved);
      }
      if (initial || changed) {
        initial = false;
        cancelAnimationFrame(revealFrame);
        revealFrame = requestAnimationFrame(() => {
          if (stopped) return;
          revealTarget();
          refresh();
        });
      }
    };
    refresh = () => {
      if (stopped) return;
      cancelAnimationFrame(placeFrame);
      placeFrame = requestAnimationFrame(place);
    };
    const outside = (event: PointerEvent) => {
      if (!dialog.contains(event.target as Node)) props.close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (dialog.querySelector("[data-planner-select-open]")) return;
      event.preventDefault();
      event.stopPropagation();
      props.close();
    };
    const scroll = (event: Event) => {
      if (!dialog.contains(event.target as Node)) refresh();
    };
    place();
    focusTitle();
    const observer = new ResizeObserver(refresh);
    observer.observe(body);
    if (scope) observer.observe(scope);
    window.addEventListener("resize", refresh);
    scope?.addEventListener("scroll", scroll, true);
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("keydown", escape, true);
    onCleanup(() => {
      stopped = true;
      cancelAnimationFrame(placeFrame);
      cancelAnimationFrame(revealFrame);
      observer.disconnect();
      window.removeEventListener("resize", refresh);
      scope?.removeEventListener("scroll", scroll, true);
      window.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("keydown", escape, true);
      props.composer?.reserveSpace(0);
    });
  });
  onCleanup(() => dialog.close());
  return (
    <Portal>
      <dialog
        ref={dialog}
        class="planner-dialog"
        classList={{ "planner-composer": !!props.anchor }}
        aria-label={props.title}
        onCancel={(event) => {
          event.preventDefault();
          props.close();
        }}
        onClick={(event) => {
          if (!props.anchor && event.target === dialog) props.close();
        }}
      >
        <div class="planner-dialog-body" ref={body}>
          <header>
            <h2>{props.title}</h2>
            <button
              type="button"
              class="planner-icon-button"
              onClick={props.close}
              aria-label={pt("close")}
            >
              <PlannerGlyph name="close" />
            </button>
          </header>
          {props.children}
        </div>
      </dialog>
    </Portal>
  );
}
