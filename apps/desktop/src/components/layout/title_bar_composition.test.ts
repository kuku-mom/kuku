import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function readSource(relativePath: string): string {
  return readFileSync(resolve(sourceRoot, relativePath), "utf8");
}

describe("title bar composition", () => {
  it("hosts document tabs and right panel tabs in the title bar", () => {
    const appSource = readSource("app.tsx");
    const centerPanelSource = readSource("components/layout/center_panel.tsx");
    const rightPanelSource = readSource("components/layout/right_panel.tsx");

    expect(appSource).toContain('import TabBar from "~/components/layout/tab_bar";');
    expect(appSource).toContain(
      'import RightPanelTabBar from "~/components/layout/right_panel_tab_bar";',
    );
    expect(appSource).toContain("<TabBar />");
    expect(appSource).toContain("<RightPanelTabBar />");
    expect(appSource).not.toContain("vaultState.rootName");
    expect(appSource).not.toContain('t("app.title.vault_fallback")');

    expect(centerPanelSource).not.toContain("<TabBar />");
    expect(rightPanelSource).not.toContain("<RightPanelTabBar />");
  });

  it("uses the title bar center slot as flexible inline chrome", () => {
    const titleBarSource = readSource("components/layout/title_bar.tsx");

    expect(titleBarSource).toContain(
      'class="absolute inset-0 z-10 flex h-full min-w-0 items-stretch"',
    );
    expect(titleBarSource).toContain(
      'class="absolute inset-y-0 left-0 z-20 flex items-center px-2"',
    );
    expect(titleBarSource).toContain(
      'class="absolute inset-y-0 right-0 z-20 flex items-center px-2"',
    );
    expect(titleBarSource).not.toContain("absolute inset-x-0");
  });

  it("keeps unused title bar areas draggable", () => {
    const appSource = readSource("app.tsx");
    const titleBarSource = readSource("components/layout/title_bar.tsx");
    const tabBarSource = readSource("components/layout/tab_bar.tsx");
    const rightPanelTabBarSource = readSource("components/layout/right_panel_tab_bar.tsx");

    expect(titleBarSource).toContain("const DRAG");
    expect(titleBarSource).toContain('data-kuku-titlebar-left-hit-area="true"');
    expect(titleBarSource).toContain('data-kuku-titlebar-right-hit-area="true"');
    expect(titleBarSource).toContain('data-kuku-titlebar-left-controls="true"');
    expect(titleBarSource).toContain('data-kuku-titlebar-right-controls="true"');
    expect(appSource).not.toContain('<div class="flex h-full min-w-0" style={NO_DRAG_STYLE}>');
    expect(tabBarSource).toContain('data-kuku-tabbar-drag-track="true"');
    expect(tabBarSource).toContain('data-kuku-tab-hit-area="true"');
    expect(tabBarSource).toContain('data-kuku-tabbar-actions="true"');
    expect(rightPanelTabBarSource).toContain('data-kuku-right-tabbar-drag-track="true"');
    expect(rightPanelTabBarSource).toContain('data-kuku-right-tab-hit-area="true"');
  });

  it("aligns top-level tabs to the side panel boundaries", () => {
    const appSource = readSource("app.tsx");

    expect(appSource).toContain("const RESIZE_HANDLE_PX = 1;");
    expect(appSource).toContain("const COLLAPSED_LEFT_RAIL_PX = 0;");
    expect(appSource).toContain("layoutState.leftPanelWidth + RESIZE_HANDLE_PX");
    expect(appSource).toContain("layoutState.rightPanelWidth + RESIZE_HANDLE_PX");
    expect(appSource).toContain('"grid-template-columns": titleBarGridTemplateColumns()');
    expect(appSource).toContain('data-kuku-titlebar-panel-grid="true"');
  });

  it("draws the top tab divider on the left spacer edge", () => {
    const appSource = readSource("app.tsx");
    const tabBarSource = readSource("components/layout/tab_bar.tsx");

    expect(appSource).toContain(
      '<div class="h-full border-r border-border" aria-hidden="true" />',
    );
    expect(tabBarSource).not.toContain("border-l border-border");
  });

  it("shows a display-only new tab placeholder when no files are open", () => {
    const tabBarSource = readSource("components/layout/tab_bar.tsx");

    expect(tabBarSource).toContain("filesState.tabs.length === 0");
    expect(tabBarSource).toContain('data-kuku-placeholder-tab="true"');
    expect(tabBarSource).toContain('t("tabbar.action.new_tab")');

    const placeholderIndex = tabBarSource.indexOf('data-kuku-placeholder-tab="true"');
    const placeholderSource = tabBarSource.slice(placeholderIndex, placeholderIndex + 700);

    expect(placeholderSource).not.toContain("openTab(");
    expect(placeholderSource).not.toContain("createAndOpenNewFile(");
    expect(placeholderSource).not.toContain("setActiveTab(");
    expect(placeholderSource).toContain("z-10");
    expect(placeholderSource).toContain("bg-bg-primary");
    expect(placeholderSource).toContain("text-text-primary");
  });

  it("gives tab labels enough line height for Korean glyphs", () => {
    const tabBarSource = readSource("components/layout/tab_bar.tsx");

    expect(tabBarSource).not.toContain("truncate leading-none");
    expect(tabBarSource).toContain("truncate leading-normal");
  });

  it("does not draw a bottom divider on the title bar", () => {
    const titleBarSource = readSource("components/layout/title_bar.tsx");

    expect(titleBarSource).not.toContain("border-b border-border");
  });

  it("does not draw lower separators inside title bar tab surfaces", () => {
    const tabBarSource = readSource("components/layout/tab_bar.tsx");
    const rightPanelTabBarSource = readSource("components/layout/right_panel_tab_bar.tsx");

    expect(tabBarSource).not.toContain("border-b border-border");
    expect(tabBarSource).not.toContain("-mb-px");
    expect(tabBarSource).not.toContain("-bottom-px h-px");
    expect(rightPanelTabBarSource).not.toContain("-mb-px");
    expect(rightPanelTabBarSource).not.toContain("-bottom-px h-px");
  });

  it("keeps the title bar height at 34px", () => {
    const titleBarSource = readSource("components/layout/title_bar.tsx");
    const layoutSource = readSource("stores/layout.ts");

    expect(titleBarSource).toContain("h-8.5");
    expect(titleBarSource).not.toContain("h-11");
    expect(titleBarSource).not.toContain("h-10");
    expect(layoutSource).toContain("const CHROME_HEIGHT = 34;");
    expect(layoutSource).not.toContain("const CHROME_HEIGHT = 44;");
    expect(layoutSource).not.toContain("const CHROME_HEIGHT = 40;");
  });
});
