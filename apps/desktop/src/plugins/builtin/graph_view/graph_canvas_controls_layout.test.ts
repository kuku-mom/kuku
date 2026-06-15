/// <reference types="node" />

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

function source(relativePath: string): string {
  return readFileSync(resolve(__dirname, relativePath), "utf8");
}

describe("graph canvas controls layout", () => {
  it("places 2D graph controls in the upper-right vertical stack", () => {
    const canvasSource = source("graph_canvas_pixi.tsx");

    expect(canvasSource).toContain('data-kuku-graph-canvas-controls="true"');
    expect(canvasSource).toContain("absolute top-32 right-3 flex w-10 flex-col items-center gap-1");
    expect(canvasSource).toContain('"top-24! right-2! w-7! gap-0! p-0.5!": isCompact()');
    expect(canvasSource).not.toContain("absolute right-3 bottom-3 flex items-center");
    expect(canvasSource).toContain('"size-8": !props.compact');
    expect(canvasSource).toContain("h-6 w-8");
    expect(canvasSource).not.toContain("min-w-11");
    expect(canvasSource).not.toContain("my-1 h-px");
  });

  it("places 3D graph controls in the upper-right vertical stack", () => {
    const canvasSource = source("graph_canvas_3d.tsx");

    expect(canvasSource).toContain('data-kuku-graph-canvas-controls="true"');
    expect(canvasSource).toContain("absolute top-32 right-3 flex w-10 flex-col items-center gap-1");
    expect(canvasSource).toContain('"top-24! right-2! w-7! gap-0! p-0.5!": isCompact()');
    expect(canvasSource).not.toContain("absolute right-3 bottom-3 flex items-center");
    expect(canvasSource).toContain('"size-8": !props.compact');
    expect(canvasSource).toContain("h-6 w-8");
    expect(canvasSource).not.toContain("min-w-11");
    expect(canvasSource).not.toContain("my-1 h-px");
  });

  it("does not render extra node-name popovers on hover", () => {
    const pixiSource = source("graph_canvas_pixi.tsx");
    const threeSource = source("graph_canvas_3d.tsx");

    expect(pixiSource).toContain("selected || current || hovered");
    expect(pixiSource).toContain("(selected || current || hovered)");
    expect(pixiSource).not.toContain("Show when={hoveredNode()}");
    expect(pixiSource).not.toContain("bottom-12 left-3");
    expect(pixiSource).not.toContain("graph.tooltip.");

    expect(threeSource).toContain("const hoverOnly = hovered && !selected && !current");
    expect(threeSource).toContain("!hoverOnly &&");
    expect(threeSource).not.toContain("Show when={hoveredNode()}");
    expect(threeSource).not.toContain("bottom-14 left-3");
    expect(threeSource).not.toContain("connectedToHovered");
  });

  it("uses the configured editor font for graph labels", () => {
    const pixiSource = source("graph_canvas_pixi.tsx");
    const threeSource = source("graph_canvas_3d.tsx");

    expect(pixiSource).toContain('cssVar("--font-editor"');
    expect(pixiSource).toContain("settingsState.editor.fontFamily");
    expect(pixiSource).not.toContain('fontFamily: "Goorm Sans');

    expect(threeSource).toContain('cssVar("--font-editor"');
    expect(threeSource).toContain("settingsState.editor.fontFamily");
    expect(threeSource).not.toContain('sprite.fontFace = "Goorm Sans');
  });
});
