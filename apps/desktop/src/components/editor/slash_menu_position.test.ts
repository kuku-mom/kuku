import { describe, it, expect } from "vitest";
import { computeSlashMenuPosition } from "~/components/editor/slash_menu_position";

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

describe("computeSlashMenuPosition", () => {
  it("anchors below the cursor when there is enough visible space", () => {
    const position = computeSlashMenuPosition({
      anchorRect: { top: 100, bottom: 120, left: 200 },
      containerRect: createRect({ top: 0, left: 0, width: 800, height: 600 }),
      viewportRect: createRect({ top: 0, left: 0, width: 800, height: 600 }),
      menuWidth: 320,
      menuMaxHeight: 320,
    });

    expect(position).toEqual({
      top: 128,
      left: 200,
      width: 320,
      maxHeight: 320,
      flip: false,
    });
  });

  it("flips above when the menu would overflow below the visible viewport", () => {
    const position = computeSlashMenuPosition({
      anchorRect: { top: 560, bottom: 580, left: 200 },
      containerRect: createRect({ top: 0, left: 0, width: 800, height: 600 }),
      viewportRect: createRect({ top: 0, left: 0, width: 800, height: 600 }),
      menuWidth: 320,
      menuMaxHeight: 320,
    });

    expect(position).toEqual({
      top: 232,
      left: 200,
      width: 320,
      maxHeight: 320,
      flip: true,
    });
  });

  it("clamps to the visible viewport when the container is scrolled", () => {
    const position = computeSlashMenuPosition({
      anchorRect: { top: 430, bottom: 450, left: 740 },
      containerRect: createRect({ top: -900, left: -400, width: 1600, height: 2400 }),
      viewportRect: createRect({ top: 100, left: 50, width: 640, height: 360 }),
      menuWidth: 320,
      menuMaxHeight: 320,
    });

    expect(position).toEqual({
      top: 1008,
      left: 762,
      width: 320,
      maxHeight: 320,
      flip: true,
    });
  });

  it("shrinks the menu to fit narrow and short viewports", () => {
    const position = computeSlashMenuPosition({
      anchorRect: { top: 150, bottom: 170, left: 200 },
      containerRect: createRect({ top: 0, left: 0, width: 280, height: 200 }),
      viewportRect: createRect({ top: 0, left: 0, width: 280, height: 200 }),
      menuWidth: 320,
      menuMaxHeight: 320,
    });

    expect(position).toEqual({
      top: 8,
      left: 8,
      width: 264,
      maxHeight: 184,
      flip: true,
    });
  });
});
