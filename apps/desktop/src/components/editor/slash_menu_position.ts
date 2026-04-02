export interface SlashMenuPosition {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
  flip: boolean;
}

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

interface ComputeSlashMenuPositionOptions {
  anchorRect: AnchorRectLike;
  containerRect: RectLike;
  viewportRect: RectLike;
  menuWidth: number;
  menuMaxHeight: number;
  margin?: number;
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export function computeSlashMenuPosition({
  anchorRect,
  containerRect,
  viewportRect,
  menuWidth,
  menuMaxHeight,
  margin = 8,
}: ComputeSlashMenuPositionOptions): SlashMenuPosition {
  const availableWidth = viewportRect.width - margin * 2;
  const availableHeight = viewportRect.height - margin * 2;
  const width = availableWidth > 0 ? Math.min(menuWidth, availableWidth) : menuWidth;
  const maxHeight = availableHeight > 0 ? Math.min(menuMaxHeight, availableHeight) : menuMaxHeight;

  const anchorTop = anchorRect.top - containerRect.top;
  const anchorBottom = anchorRect.bottom - containerRect.top;
  const anchorLeft = anchorRect.left - containerRect.left;

  const viewportTop = viewportRect.top - containerRect.top;
  const viewportBottom = viewportRect.bottom - containerRect.top;
  const viewportLeft = viewportRect.left - containerRect.left;
  const viewportRight = viewportRect.right - containerRect.left;

  const spaceBelow = viewportRect.bottom - anchorRect.bottom;
  const spaceAbove = anchorRect.top - viewportRect.top;
  const flip = spaceBelow < maxHeight + margin && spaceAbove > spaceBelow;

  const preferredTop = flip ? anchorTop - maxHeight - margin : anchorBottom + margin;
  const minTop = viewportTop + margin;
  const maxTop = Math.max(minTop, viewportBottom - maxHeight - margin);

  const minLeft = viewportLeft + margin;
  const maxLeft = Math.max(minLeft, viewportRight - width - margin);

  return {
    top: clamp(preferredTop, minTop, maxTop),
    left: clamp(anchorLeft, minLeft, maxLeft),
    width,
    maxHeight,
    flip,
  };
}
