import { createSignal, onCleanup } from "solid-js";

// ── Types ──

interface ResizeHandleProps {
  /** Resize direction: "col" for horizontal, "row" for vertical */
  direction: "col" | "row";
  /** Current value getter */
  getValue: () => number;
  /** Callback when value changes */
  onResize: (value: number) => void;
  /** Reverse drag direction (e.g. right panel or bottom panel) */
  reverse?: boolean;
}

// ── Component ──

export default function ResizeHandle(props: ResizeHandleProps) {
  const [active, setActive] = createSignal(false);
  const isCol = () => props.direction === "col";

  let teardown: (() => void) | null = null;

  onCleanup(() => teardown?.());

  function onPointerDown(e: PointerEvent) {
    e.preventDefault();
    setActive(true);

    const startPos = isCol() ? e.clientX : e.clientY;
    const startValue = props.getValue();

    document.body.style.userSelect = "none";
    document.body.style.cursor = isCol() ? "col-resize" : "row-resize";

    function onPointerMove(moveEvent: PointerEvent) {
      const currentPos = isCol() ? moveEvent.clientX : moveEvent.clientY;
      const delta = currentPos - startPos;
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

  return (
    <div
      class={`relative z-10 shrink-0 transition-colors before:absolute before:content-[''] hover:bg-accent ${
        isCol()
          ? "w-px cursor-col-resize bg-border before:-inset-x-0.5 before:inset-y-0"
          : "h-px cursor-row-resize bg-border before:inset-x-0 before:-inset-y-0.5"
      }`}
      classList={{ "bg-accent!": active() }}
      onPointerDown={onPointerDown}
    />
  );
}
