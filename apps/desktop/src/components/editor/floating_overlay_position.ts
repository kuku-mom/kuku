interface AnchorRectLike {
  top: number;
  bottom: number;
  left: number;
}

interface RectLike {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
  height: number;
}

interface ComputeFloatingOverlayPositionOptions {
  anchorRect: AnchorRectLike;
  containerRect: RectLike;
  viewportRect: RectLike;
  overlayWidth: number;
  overlayHeight: number;
  margin?: number;
  verticalOffset?: number;
}

interface FloatingOverlayPosition {
  top: number;
  left: number;
  width: number;
  flip: boolean;
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export function computeFloatingOverlayPosition({
  anchorRect,
  containerRect,
  viewportRect,
  overlayWidth,
  overlayHeight,
  margin = 8,
  verticalOffset = margin,
}: ComputeFloatingOverlayPositionOptions): FloatingOverlayPosition {
  const availableWidth = viewportRect.width - margin * 2;
  const width = availableWidth > 0 ? Math.min(overlayWidth, availableWidth) : overlayWidth;

  const anchorTop = anchorRect.top - containerRect.top;
  const anchorBottom = anchorRect.bottom - containerRect.top;
  const anchorLeft = anchorRect.left - containerRect.left;

  const viewportTop = viewportRect.top - containerRect.top;
  const viewportBottom = viewportRect.bottom - containerRect.top;
  const viewportLeft = viewportRect.left - containerRect.left;
  const viewportRight = viewportRect.right - containerRect.left;

  const spaceBelow = viewportRect.bottom - anchorRect.bottom;
  const spaceAbove = anchorRect.top - viewportRect.top;
  const flip = spaceBelow < overlayHeight + verticalOffset && spaceAbove > spaceBelow;

  const preferredTop = flip
    ? anchorTop - overlayHeight - verticalOffset
    : anchorBottom + verticalOffset;
  const minTop = viewportTop + margin;
  const maxTop = Math.max(minTop, viewportBottom - overlayHeight - margin);

  const minLeft = viewportLeft + margin;
  const maxLeft = Math.max(minLeft, viewportRight - width - margin);

  return {
    top: clamp(preferredTop, minTop, maxTop),
    left: clamp(anchorLeft, minLeft, maxLeft),
    width,
    flip,
  };
}

export type { FloatingOverlayPosition };
