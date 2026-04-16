import { describe, expect, it } from "vitest";

import { computeFloatingOverlayPosition } from "~/components/editor/floating_overlay_position";

interface RectInput {
  top: number;
  left: number;
  width: number;
  height: number;
}

function createRect({ top, left, width, height }: RectInput) {
  return {
    top,
    left,
    width,
    height,
    right: left + width,
    bottom: top + height,
  };
}

describe("computeFloatingOverlayPosition", () => {
  it("anchors below when there is enough visible space", () => {
    const position = computeFloatingOverlayPosition({
      anchorRect: { top: 100, bottom: 120, left: 200 },
      containerRect: createRect({ top: 0, left: 0, width: 800, height: 1200 }),
      viewportRect: createRect({ top: 0, left: 0, width: 800, height: 600 }),
      overlayWidth: 320,
      overlayHeight: 44,
    });

    expect(position).toEqual({
      top: 128,
      left: 200,
      width: 320,
      flip: false,
    });
  });

  it("flips above when the visible viewport has no room below", () => {
    const position = computeFloatingOverlayPosition({
      anchorRect: { top: 560, bottom: 580, left: 200 },
      containerRect: createRect({ top: 0, left: 0, width: 800, height: 1200 }),
      viewportRect: createRect({ top: 0, left: 0, width: 800, height: 600 }),
      overlayWidth: 320,
      overlayHeight: 120,
      verticalOffset: 10,
    });

    expect(position).toEqual({
      top: 430,
      left: 200,
      width: 320,
      flip: true,
    });
  });

  it("clamps inside the visible viewport when the container is scrolled", () => {
    const position = computeFloatingOverlayPosition({
      anchorRect: { top: 430, bottom: 450, left: 740 },
      containerRect: createRect({ top: -900, left: -400, width: 1600, height: 2400 }),
      viewportRect: createRect({ top: 100, left: 50, width: 640, height: 360 }),
      overlayWidth: 320,
      overlayHeight: 44,
    });

    expect(position).toEqual({
      top: 1278,
      left: 762,
      width: 320,
      flip: true,
    });
  });
});
