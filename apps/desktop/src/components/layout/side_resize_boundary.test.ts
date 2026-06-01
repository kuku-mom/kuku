import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

describe("side resize boundary", () => {
  const sourcePath = resolve(dirname(fileURLToPath(import.meta.url)), "side_resize_boundary.tsx");

  it("renders one full-height boundary for either side", () => {
    const source = readFileSync(sourcePath, "utf8");

    expect(source).toContain('side: "left" | "right";');
    expect(source).toContain('data-kuku-side-resize-boundary={props.side}');
    expect(source).toContain('class="absolute inset-y-0 z-40 w-px"');
    expect(source).toContain('props.side === "left"');
    expect(source).toContain('left: `${props.getValue()}px`');
    expect(source).toContain('right: `${props.getValue()}px`');
    expect(source).toContain("style={positionStyle()}");
  });

  it("owns hover and drag state locally", () => {
    const source = readFileSync(sourcePath, "utf8");

    expect(source).toContain("const [active, setActive]");
    expect(source).toContain("const [hovered, setHovered]");
    expect(source).toContain("setActive(true);");
    expect(source).toContain("setActive(false);");
    expect(source).toContain("setHovered(true);");
    expect(source).toContain("setHovered(false);");
    expect(source).toContain('data-active={active() ? "" : undefined}');
    expect(source).toContain('data-hovered={hovered() && !active() ? "" : undefined}');
    expect(source).not.toContain("setActiveSideResize");
    expect(source).not.toContain("setHoveredSideResize");
  });

  it("uses the same drag math as the upstream resize handle", () => {
    const source = readFileSync(sourcePath, "utf8");

    expect(source).toContain("const startX = e.clientX;");
    expect(source).toContain("const startValue = props.getValue();");
    expect(source).toContain("const delta = moveEvent.clientX - startX;");
    expect(source).toContain("props.onResize(props.reverse ? startValue - delta : startValue + delta);");
    expect(source).toContain('document.body.style.cursor = "col-resize";');
    expect(source).toContain('document.removeEventListener("pointermove", onPointerMove);');
  });

  it("keeps the wide hit target separate from the visual line", () => {
    const source = readFileSync(sourcePath, "utf8");
    const resizeGripSource = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "../../styles/resize_grip.css"),
      "utf8",
    );

    expect(source).toContain("kuku-side-resize-boundary-hit");
    expect(source).toContain("kuku-resize-line-hit kuku-resize-line-hit--col");
    expect(resizeGripSource).toContain(".kuku-side-resize-boundary-hit");
    expect(resizeGripSource).toContain("width: 10px;");
    expect(resizeGripSource).toContain("cursor: col-resize;");
    expect(resizeGripSource).toContain("transform: translateX(-50%);");
  });
});
