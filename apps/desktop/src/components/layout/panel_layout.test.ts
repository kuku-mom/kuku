import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

describe("panel layout", () => {
  it("offsets the collapsed left panel preview past the rail toggle", () => {
    const sourcePath = resolve(dirname(fileURLToPath(import.meta.url)), "panel_layout.tsx");
    const source = readFileSync(sourcePath, "utf8");
    const previewIndex = source.indexOf('data-kuku-left-panel-preview="true"');
    const previewBlock = source.slice(Math.max(0, previewIndex - 200), previewIndex + 200);

    expect(previewIndex).toBeGreaterThan(-1);
    expect(previewBlock).toContain("left-10");
    expect(previewBlock).not.toContain("left-0");
  });

  it("keeps only resize handles as separators beside open side panels", () => {
    const sourceDir = dirname(fileURLToPath(import.meta.url));
    const leftPanelSource = readFileSync(resolve(sourceDir, "left_panel.tsx"), "utf8");
    const rightPanelSource = readFileSync(resolve(sourceDir, "right_panel.tsx"), "utf8");
    const resizeHandleSource = readFileSync(resolve(sourceDir, "resize_handle.tsx"), "utf8");

    expect(leftPanelSource).not.toContain("border-r border-border");
    expect(rightPanelSource).not.toContain("border-l border-border");
    expect(resizeHandleSource).toContain('"bg-border hover:bg-border/80": !active()');
  });
});
