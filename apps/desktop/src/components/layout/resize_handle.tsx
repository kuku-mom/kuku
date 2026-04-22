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
      class={`relative z-10 shrink-0 ${
        isCol() ? "w-px" : "h-px w-full"
      }`}
    >
      {/* Graph-paper style strip only while pointer-drag is active — avoids heavy accent / black bar */}
      <div
        classList={{
          "kuku-resize-grip kuku-resize-grip--col": isCol(),
          "kuku-resize-grip kuku-resize-grip--row": !isCol(),
        }}
        data-active={active() ? "" : undefined}
        aria-hidden="true"
      />
      <div
        onPointerDown={onPointerDown}
        classList={{
          "relative z-10 shrink-0 before:absolute before:z-20 before:content-['']": true,
          "h-full w-px cursor-col-resize before:-inset-x-0.5 before:inset-y-0": isCol(),
          "h-px w-full cursor-row-resize before:-inset-y-0.5 before:inset-x-0": !isCol(),
          "bg-border hover:bg-border/80": !active(),
          "bg-transparent": active(),
        }}
      />
    </div>
  );
}
