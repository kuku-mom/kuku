export interface ComposerRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface ComposerPlacement {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
  placement: "left" | "right" | "docked";
  reservedHeight: number;
}

const PADDING = 12;
const GAP = 12;
const MIN_WIDTH = 320;
const NATURAL_WIDTH = 360;

function finite(value: number, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}
function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

/** Coordinates are in the viewport. Bounds must already exclude app sidebars. */
export function placeComposer(
  bounds: ComposerRect,
  target: ComposerRect,
  size: { width: number; height: number },
): ComposerPlacement {
  const left = finite(bounds.left);
  const top = finite(bounds.top);
  const right = Math.max(left, finite(bounds.right, left));
  const bottom = Math.max(top, finite(bounds.bottom, top));
  const boundsWidth = right - left;
  const boundsHeight = bottom - top;
  // Collapse padding along with the surface when the window becomes very small.
  const paddingX = Math.min(PADDING, boundsWidth / 2);
  const paddingY = Math.min(PADDING, boundsHeight / 2);
  const innerLeft = left + paddingX;
  const innerRight = right - paddingX;
  const innerTop = top + paddingY;
  const innerBottom = bottom - paddingY;
  const targetLeft = clamp(finite(target.left, left), left, right);
  const targetRight = clamp(finite(target.right, targetLeft), targetLeft, right);
  const naturalWidth = clamp(finite(size.width, NATURAL_WIDTH), MIN_WIDTH, NATURAL_WIDTH);
  const naturalHeight = Math.max(0, finite(size.height));
  const rightSpace = Math.max(0, innerRight - targetRight - GAP);
  const leftSpace = Math.max(0, targetLeft - GAP - innerLeft);
  const maxHeight = Math.min(naturalHeight, innerBottom - innerTop);
  const sideTop = clamp(finite(target.top, top) - PADDING, innerTop, innerBottom - maxHeight);

  // Prefer an uncompressed form on either side before narrowing the form.
  const candidates: { placement: "left" | "right"; width: number }[] = [
    { placement: "right", width: naturalWidth },
    { placement: "left", width: naturalWidth },
    { placement: "right", width: Math.min(naturalWidth, rightSpace) },
    { placement: "left", width: Math.min(naturalWidth, leftSpace) },
  ];
  for (const candidate of candidates) {
    const available = candidate.placement === "right" ? rightSpace : leftSpace;
    if (candidate.width < MIN_WIDTH || candidate.width > available) continue;
    return {
      left:
        candidate.placement === "right" ? targetRight + GAP : targetLeft - GAP - candidate.width,
      top: sideTop,
      width: candidate.width,
      maxHeight,
      placement: candidate.placement,
      reservedHeight: 0,
    };
  }

  const dockHeight = Math.min(naturalHeight, boundsHeight * 0.55, innerBottom - innerTop);
  return {
    left: innerLeft,
    top: innerBottom - dockHeight,
    width: innerRight - innerLeft,
    maxHeight: dockHeight,
    placement: "docked",
    // The calendar reserves this space and scrolls the selected slot above it.
    reservedHeight: Math.min(boundsHeight, dockHeight + paddingY * 2),
  };
}
