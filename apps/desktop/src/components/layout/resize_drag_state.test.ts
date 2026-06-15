// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";

import {
  LAYOUT_RESIZE_ACTIVE_ATTR,
  beginLayoutResizeDrag,
  endLayoutResizeDrag,
} from "./resize_drag_state";

describe("layout resize drag state", () => {
  beforeEach(() => {
    document.documentElement.removeAttribute(LAYOUT_RESIZE_ACTIVE_ATTR);
  });

  it("marks the document while a layout resize drag is active", () => {
    beginLayoutResizeDrag(document);

    expect(document.documentElement.hasAttribute(LAYOUT_RESIZE_ACTIVE_ATTR)).toBe(true);

    endLayoutResizeDrag(document);

    expect(document.documentElement.hasAttribute(LAYOUT_RESIZE_ACTIVE_ATTR)).toBe(false);
  });
});
