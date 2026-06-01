import { createSignal, onCleanup } from "solid-js";

const NO_DRAG = {
  "-webkit-app-region": "no-drag",
  "app-region": "no-drag",
} as Record<string, string>;

interface TitleBarResizeHandleProps {
  side: "left" | "right";
  active: boolean;
  hovered: boolean;
  getValue: () => number;
  onResize: (value: number) => void;
  reverse?: boolean;
  onResizeStart?: () => void;
  onResizeEnd?: () => void;
  onResizeHoverStart?: () => void;
  onResizeHoverEnd?: () => void;
  "data-kuku-titlebar-left-resize-hit-area"?: string;
  "data-kuku-titlebar-right-resize-hit-area"?: string;
}

export default function TitleBarResizeHandle(props: TitleBarResizeHandleProps) {
  const [active, setActive] = createSignal(false);
  const [hovered, setHovered] = createSignal(false);
  const isActive = () => active() || props.active;
  const isHovered = () => hovered() || props.hovered;

  let teardown: (() => void) | null = null;

  onCleanup(() => teardown?.());

  function onPointerDown(e: PointerEvent) {
    e.preventDefault();
    e.stopPropagation();
    setActive(true);
    props.onResizeStart?.();

    const startPos = e.clientX;
    const startValue = props.getValue();

    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";

    function onPointerMove(moveEvent: PointerEvent) {
      const delta = moveEvent.clientX - startPos;
      props.onResize(props.reverse ? startValue - delta : startValue + delta);
    }

    function cleanup() {
      setActive(false);
      props.onResizeEnd?.();
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
    props.onResizeHoverStart?.();
  }

  function onPointerLeave() {
    setHovered(false);
    props.onResizeHoverEnd?.();
  }

  return (
    <div
      classList={{
        "kuku-titlebar-resize-handle": true,
        "absolute inset-y-0 z-40 w-px": true,
        "right-0": props.side === "left",
        "left-0": props.side === "right",
      }}
      style={NO_DRAG}
      data-kuku-titlebar-left-resize-hit-area={
        props["data-kuku-titlebar-left-resize-hit-area"]
      }
      data-kuku-titlebar-right-resize-hit-area={
        props["data-kuku-titlebar-right-resize-hit-area"]
      }
    >
      <span
        data-kuku-titlebar-left-resize-grip={props.side === "left" ? "true" : undefined}
        data-kuku-titlebar-right-resize-grip={props.side === "right" ? "true" : undefined}
        class="kuku-resize-grip kuku-resize-grip--col"
        data-active={isActive() ? "" : undefined}
        aria-hidden="true"
      />
      <span
        data-kuku-titlebar-resize-line="true"
        class="pointer-events-none absolute inset-y-0 left-0 w-px kuku-resize-line-hit kuku-resize-line-hit--col"
        data-hovered={isHovered() && !isActive() ? "" : undefined}
        aria-hidden="true"
      />
      <div
        onPointerDown={onPointerDown}
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
        classList={{
          "kuku-titlebar-resize-hit kuku-titlebar-resize-hit--left": props.side === "left",
          "kuku-titlebar-resize-hit kuku-titlebar-resize-hit--right": props.side === "right",
        }}
      />
    </div>
  );
}
