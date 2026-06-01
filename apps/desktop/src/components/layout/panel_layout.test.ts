import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

describe("panel layout", () => {
  it("does not render a collapsed left ribbon rail", () => {
    const sourcePath = resolve(dirname(fileURLToPath(import.meta.url)), "panel_layout.tsx");
    const source = readFileSync(sourcePath, "utf8");

    expect(source).not.toContain("openLeftPanelPreview");
    expect(source).not.toContain("leftPanelPreviewOpen");
    expect(source).not.toContain('data-kuku-left-panel-preview="true"');
    expect(source).not.toContain("w-10");
  });

  it("keeps only resize handles as separators beside open side panels", () => {
    const sourceDir = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(resolve(sourceDir, "panel_layout.tsx"), "utf8");
    const leftPanelSource = readFileSync(resolve(sourceDir, "left_panel.tsx"), "utf8");
    const rightPanelSource = readFileSync(resolve(sourceDir, "right_panel.tsx"), "utf8");
    const resizeHandleSource = readFileSync(resolve(sourceDir, "resize_handle.tsx"), "utf8");

    expect(leftPanelSource).not.toContain("border-r border-border");
    expect(rightPanelSource).not.toContain("border-l border-border");
    expect(resizeHandleSource).toContain('data-hovered={isHovered() && !isActive() ? "" : undefined}');
    expect(source).toContain('onResizeStart={() => setActiveSideResize("left")}');
    expect(source).toContain("active={isLeftPanelResizing()}");
    expect(source).toContain("hovered={isLeftPanelResizeHovered()}");
    expect(source).toContain("onResizeEnd={clearActiveSideResize}");
    expect(source).toContain('onResizeHoverStart={() => setHoveredSideResize("left")}');
    expect(source).toContain("onResizeHoverEnd={clearHoveredSideResize}");
    expect(source).toContain('onResizeStart={() => setActiveSideResize("right")}');
    expect(source).toContain("active={isRightPanelResizing()}");
    expect(source).toContain("hovered={isRightPanelResizeHovered()}");
    expect(source).toContain('onResizeHoverStart={() => setHoveredSideResize("right")}');
  });
});
