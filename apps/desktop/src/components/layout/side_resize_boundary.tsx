import { createSignal, onCleanup } from "solid-js";

const NO_DRAG = {
  "-webkit-app-region": "no-drag",
  "app-region": "no-drag",
} as Record<string, string>;

interface SideResizeBoundaryProps {
  side: "left" | "right";
  getValue: () => number;
  onResize: (value: number) => void;
  reverse?: boolean;
}

export default function SideResizeBoundary(props: SideResizeBoundaryProps) {
  const [active, setActive] = createSignal(false);
  const [hovered, setHovered] = createSignal(false);

  let teardown: (() => void) | null = null;

  onCleanup(() => teardown?.());

  function positionStyle(): Record<string, string> {
    if (props.side === "left") {
      return { ...NO_DRAG, left: `${props.getValue()}px` };
    }

    return { ...NO_DRAG, right: `${props.getValue()}px` };
  }

  function onPointerDown(e: PointerEvent) {
    e.preventDefault();
    e.stopPropagation();
    setActive(true);

    const startX = e.clientX;
    const startValue = props.getValue();

    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";

    function onPointerMove(moveEvent: PointerEvent) {
      const delta = moveEvent.clientX - startX;
      props.onResize(props.reverse ? startValue - delta : startValue + delta);
    }

    function cleanup() {
      setActive(false);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerup", cleanup);
      document.removeEventListener("pointercancel", cleanup);
      teardown = null;
    }

    teardown = cleanup;
    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", cleanup);
    document.addEventListener("pointercancel", cleanup);
  }

  function onPointerEnter() {
    setHovered(true);
  }

  function onPointerLeave() {
    setHovered(false);
  }

  return (
    <div
      data-kuku-side-resize-boundary={props.side}
      class="absolute inset-y-0 z-40 w-px"
      classList={{
        "bg-border": !active() && !hovered(),
        "bg-transparent": active() || hovered(),
      }}
      style={positionStyle()}
    >
      <span
        class="kuku-resize-grip kuku-resize-grip--col"
        data-active={active() ? "" : undefined}
        aria-hidden="true"
      />
      <span
        class="pointer-events-none absolute inset-y-0 left-0 w-px kuku-resize-line-hit kuku-resize-line-hit--col"
        data-hovered={hovered() && !active() ? "" : undefined}
        aria-hidden="true"
      />
      <div
        class="kuku-side-resize-boundary-hit"
        onPointerDown={onPointerDown}
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
      />
    </div>
  );
}
