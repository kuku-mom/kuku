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

  it("leaves side panel boundaries to the full-height resize boundary", () => {
    const sourceDir = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(resolve(sourceDir, "panel_layout.tsx"), "utf8");
    const leftPanelSource = readFileSync(resolve(sourceDir, "left_panel.tsx"), "utf8");
    const rightPanelSource = readFileSync(resolve(sourceDir, "right_panel.tsx"), "utf8");
    const resizeHandleSource = readFileSync(resolve(sourceDir, "resize_handle.tsx"), "utf8");

    expect(leftPanelSource).not.toContain("border-r border-border");
    expect(rightPanelSource).not.toContain("border-l border-border");
    expect(resizeHandleSource).toContain('data-hovered={hovered() && !active() ? "" : undefined}');
    expect(source).not.toContain('direction="col"');
    expect(source).not.toContain("setLeftPanelWidth");
    expect(source).not.toContain("setRightPanelWidth");
    expect(source).not.toContain("setActiveSideResize");
    expect(source).not.toContain("setHoveredSideResize");
    expect(source).not.toContain("isLeftPanelResizing");
    expect(source).not.toContain("isRightPanelResizing");
    expect(source).toContain('direction="row"');
    expect(source).toContain("setBottomPanelHeight");
  });
});
