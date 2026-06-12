// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { parseKukuWidgetSource } from "./widget_source";
import { getWidgetResizeHeight, shouldStopWidgetNodeEventTarget } from "./widget_resize";

describe("widget embed node", () => {
  it("parses editable widget source into widget attributes", () => {
    expect(parseKukuWidgetSource("```kuku-widget\nid: arc-map\nheight: 621\n```")).toStrictEqual({
      id: "arc-map",
      height: 621,
    });
  });

  it("computes a clamped height from vertical drag movement", () => {
    expect(getWidgetResizeHeight(320, 100, 180)).toBe(400);
    expect(getWidgetResizeHeight(320, 100, -200)).toBe(120);
    expect(getWidgetResizeHeight(320, 100, 1400)).toBe(1200);
  });

  it("keeps iframe and resize handle pointer events out of the editor", () => {
    const iframe = document.createElement("iframe");
    const handle = document.createElement("button");
    const grip = document.createElement("span");
    const source = document.createElement("textarea");
    const outside = document.createElement("div");

    handle.dataset.kukuWidgetResizeHandle = "";
    handle.append(grip);
    source.dataset.kukuWidgetSource = "";

    expect(shouldStopWidgetNodeEventTarget(eventFromTarget("pointerdown", iframe).target)).toBe(
      true,
    );
    expect(shouldStopWidgetNodeEventTarget(eventFromTarget("pointerdown", grip).target)).toBe(true);
    expect(shouldStopWidgetNodeEventTarget(eventFromTarget("input", source).target)).toBe(true);
    expect(shouldStopWidgetNodeEventTarget(eventFromTarget("pointerdown", outside).target)).toBe(
      false,
    );
  });
});

function eventFromTarget(type: string, target: Element): Event {
  let result: Event | undefined;
  target.addEventListener(type, (event) => {
    result = event;
  });
  target.dispatchEvent(new Event(type, { bubbles: true }));
  if (!result) throw new Error("Event was not captured");
  return result;
}
