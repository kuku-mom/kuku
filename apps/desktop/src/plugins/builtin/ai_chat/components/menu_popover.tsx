import { createEffect, createSignal, onCleanup, Show, type JSX } from "solid-js";

type MenuAlign = "left" | "right";

interface MenuPopoverProps {
  open: boolean;
  anchor: () => HTMLElement | undefined;
  align?: MenuAlign;
  widthClass: string;
  widthPx: number;
  dataAttributes?: Record<string, string>;
  onSurfaceMount?: (element: HTMLDivElement) => void;
  onKeyDown?: (event: KeyboardEvent) => void;
  children: JSX.Element;
}

function MenuPopover(props: MenuPopoverProps): JSX.Element {
  const [surfaceStyle, setSurfaceStyle] = createSignal<Record<string, string> | undefined>();
  const alignmentClass = () => (props.align === "right" ? "right-0" : "left-0");
  const updatePosition = () => {
    if (typeof window === "undefined") return;
    const anchor = props.anchor();
    if (!anchor) return;

    const rect = anchor.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const margin = 8;
    const preferredLeft = props.align === "right" ? rect.right - props.widthPx : rect.left;
    const maxLeft = Math.max(margin, viewportWidth - props.widthPx - margin);
    const left = Math.min(Math.max(margin, preferredLeft), maxLeft);

    setSurfaceStyle({
      position: "fixed",
      top: `${rect.bottom + 4}px`,
      left: `${left}px`,
    });
  };

  createEffect(() => {
    if (!props.open || typeof window === "undefined") return;

    queueMicrotask(updatePosition);
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    onCleanup(() => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    });
  });

  return (
    <Show when={props.open}>
      <div
        {...(props.dataAttributes ?? {})}
        role="menu"
        data-kuku-menu-popover="true"
        class={`absolute top-full ${alignmentClass()} z-1000 mt-1 max-h-[min(18rem,calc(100vh-4rem))] ${props.widthClass} overflow-y-auto rounded-sm border border-border/40 bg-bg-elevated p-1.5 [box-shadow:var(--shadow-context-surface)]`}
        style={surfaceStyle()}
        ref={(element) => props.onSurfaceMount?.(element)}
        onKeyDown={props.onKeyDown}
      >
        {props.children}
      </div>
    </Show>
  );
}

export { MenuPopover };
