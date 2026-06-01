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

  it("places the left toggle against the tab strip and keeps the right toggle in chrome", () => {
    const appSource = readSource("app.tsx");

    expect(appSource).toContain('left={<Slot name="titleBarLeftAction" />}');
    expect(appSource).toContain('<Slot name="titleBarRightAction" />');
    expect(appSource).toContain('data-kuku-titlebar-left-toggle-cell="true"');
    expect(appSource).not.toContain('data-kuku-titlebar-right-toggle-cell="true"');
    expect(appSource).toContain(
      'class="relative flex h-full items-center justify-end border-r border-border bg-bg-secondary px-1"',
    );

    const leftToggleIndex = appSource.indexOf('data-kuku-titlebar-left-toggle-cell="true"');
    const tabBarIndex = appSource.indexOf("<TabBar />");
    const rightSlotIndex = appSource.indexOf('<Slot name="titleBarRightAction" />');
    const rightToggleIndex = appSource.indexOf("toggleRightPanel", rightSlotIndex);
    const rightPanelTabBarIndex = appSource.indexOf("<RightPanelTabBar />");

    expect(leftToggleIndex).toBeLessThan(tabBarIndex);
    expect(rightPanelTabBarIndex).toBeGreaterThan(tabBarIndex);
    expect(rightSlotIndex).toBeGreaterThan(rightPanelTabBarIndex);
    expect(rightToggleIndex).toBeGreaterThan(rightSlotIndex);
  });

  it("uses the title bar center slot as flexible inline chrome", () => {
    const titleBarSource = readSource("components/layout/title_bar.tsx");

    expect(titleBarSource).toContain(
      'class="absolute inset-0 z-10 flex h-full min-w-0 items-stretch"',
    );
    expect(titleBarSource).toContain(
      'class="absolute inset-y-0 left-0 z-20 flex items-center px-1"',
    );
    expect(titleBarSource).toContain(
      'class="absolute inset-y-0 right-0 z-20 flex items-center justify-end px-1"',
    );
    expect(titleBarSource).not.toContain("flex min-w-18 items-center justify-end");
    expect(titleBarSource).not.toContain("absolute inset-x-0 flex items-center justify-center");
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
    expect(titleBarSource).toContain('class="flex shrink-0 items-center gap-1 px-1"');
    expect(titleBarSource).not.toContain('class="flex shrink-0 items-center gap-1 px-3"');
    expect(appSource).not.toContain('<div class="flex h-full min-w-0" style={NO_DRAG_STYLE}>');
    expect(tabBarSource).toContain('data-kuku-tabbar-drag-track="true"');
    expect(tabBarSource).toContain('data-kuku-tab-hit-area="true"');
    expect(tabBarSource).not.toContain('data-kuku-tabbar-actions="true"');
    expect(rightPanelTabBarSource).toContain('data-kuku-right-buttonbar-drag-track="true"');
    expect(rightPanelTabBarSource).toContain('data-kuku-right-panel-button="true"');
    expect(rightPanelTabBarSource).toContain(
      'class="relative z-10 flex h-full min-w-0 flex-1 bg-bg-secondary"',
    );
    expect(rightPanelTabBarSource).not.toContain(
      'class="relative z-10 flex h-full shrink-0 bg-bg-secondary"',
    );
    expect(rightPanelTabBarSource).not.toContain('data-kuku-right-tabbar-drag-track="true"');
    expect(rightPanelTabBarSource).not.toContain('data-kuku-right-tab-hit-area="true"');
  });

  it("uses compact sidebar toggle buttons in the title bar", () => {
    const appSource = readSource("app.tsx");

    expect(appSource).toContain("const SIDEBAR_TOGGLE_BTN =");
    expect(appSource).toContain("flex size-5 cursor-pointer items-center justify-center");
    expect(appSource).toContain("[&>svg]:size-3.5");
    expect(appSource).toContain("class={SIDEBAR_TOGGLE_BTN}");
    expect(appSource).not.toContain("const ACTION_BTN =");
    expect(appSource).not.toContain("flex size-[26px] cursor-pointer items-center justify-center");
  });

  it("aligns top-level tabs to the side panel boundaries", () => {
    const appSource = readSource("app.tsx");

    expect(appSource).toContain("const RESIZE_HANDLE_PX = 1;");
    expect(appSource).toContain("const COLLAPSED_LEFT_RAIL_PX = 0;");
    expect(appSource).toContain("layoutState.leftPanelWidth + RESIZE_HANDLE_PX");
    expect(appSource).toContain("layoutState.rightPanelWidth + RESIZE_HANDLE_PX");
    expect(appSource).not.toContain("const TITLE_BAR_RIGHT_CHROME_PX");
    expect(appSource).not.toContain("max(${panelColumnWidth}, ${TITLE_BAR_RIGHT_CHROME_PX}px)");
    expect(appSource).toContain('"grid-template-columns": titleBarGridTemplateColumns()');
    expect(appSource).toContain('data-kuku-titlebar-panel-grid="true"');
  });

  it("draws the top tab divider on the left spacer edge", () => {
    const appSource = readSource("app.tsx");
    const tabBarSource = readSource("components/layout/tab_bar.tsx");

    expect(appSource).toContain(
      'class="relative flex h-full items-center justify-end border-r border-border bg-bg-secondary px-1"',
    );
    expect(tabBarSource).not.toContain("border-l border-border");
  });

  it("hides the left toggle bottom divider while the left sidebar is open", () => {
    const appSource = readSource("app.tsx");

    const leftToggleIndex = appSource.indexOf('data-kuku-titlebar-left-toggle-cell="true"');
    const leftToggleSource = appSource.slice(leftToggleIndex, appSource.indexOf("<TabBar />"));

    expect(leftToggleSource).toContain('data-kuku-titlebar-left-toggle-bottom-divider="true"');
    expect(leftToggleSource).toContain('classList={{ hidden: layoutState.leftPanelOpen }}');
    expect(leftToggleSource).toContain("absolute inset-x-0 bottom-0 h-px bg-border");
  });

  it("uses the real placeholder tab path when no files are open", () => {
    const tabBarSource = readSource("components/layout/tab_bar.tsx");

    expect(tabBarSource).toContain("filesState.tabs.length === 0");
    expect(tabBarSource).toContain("openNewTabPlaceholder()");
    expect(tabBarSource).not.toContain("const showEmptyTabPlaceholder");
    expect(tabBarSource).not.toContain('data-kuku-placeholder-tab="true"');
    expect(tabBarSource).not.toContain('aria-disabled="true"');
    expect(tabBarSource).toContain('t("tabbar.action.new_tab")');

    const placeholderTitleIndex = tabBarSource.indexOf('tab.type === "placeholder"');
    const closeButtonIndex = tabBarSource.indexOf("{/* Close button */}");
    expect(placeholderTitleIndex).toBeGreaterThan(-1);
    expect(closeButtonIndex).toBeGreaterThan(placeholderTitleIndex);
  });

  it("gives tab labels enough line height for Korean glyphs", () => {
    const tabBarSource = readSource("components/layout/tab_bar.tsx");

    expect(tabBarSource).not.toContain("truncate leading-none");
    expect(tabBarSource).toContain("truncate leading-normal");
  });

  it("shows a file icon before each file tab title", () => {
    const tabBarSource = readSource("components/layout/tab_bar.tsx");

    expect(tabBarSource).not.toContain("const showTabIcon");
    expect(tabBarSource).not.toContain("<Show when={showTabIcon()}>");
    expect(tabBarSource).not.toContain(
      'tab.type === "graph" || tab.type === "search" || tab.type === "settings"',
    );

    const iconIndex = tabBarSource.indexOf("{/* Tab icon */}");
    const nameIndex = tabBarSource.indexOf("{/* Tab name */}");

    expect(iconIndex).toBeGreaterThan(-1);
    expect(nameIndex).toBeGreaterThan(-1);
    expect(iconIndex).toBeLessThan(nameIndex);
    expect(tabBarSource).toContain("<Switch fallback={<FileIcon size={14} />}>");
  });

  it("stretches tab drag drop indicators to the tab height", () => {
    const tabBarSource = readSource("components/layout/tab_bar.tsx");

    expect(tabBarSource).not.toContain("h-6 w-0.5 shrink-0 rounded-xs bg-accent/70");

    const dropIndicatorClass = "mx-0.5 w-0.5 shrink-0 self-stretch bg-accent/70";
    expect(tabBarSource.match(new RegExp(dropIndicatorClass, "g"))?.length).toBe(2);
  });

  it("places the new tab button immediately after the tab list", () => {
    const tabBarSource = readSource("components/layout/tab_bar.tsx");

    const tabTrackIndex = tabBarSource.indexOf('data-kuku-tabbar-drag-track="true"');
    const tabListEndIndex = tabBarSource.indexOf("</For>", tabTrackIndex);
    const inlineButtonIndex = tabBarSource.indexOf('data-kuku-inline-new-tab-button="true"');
    const scrollEndIndex = tabBarSource.indexOf("</ScrollArea>", tabTrackIndex);
    const actionsIndex = tabBarSource.indexOf('data-kuku-tabbar-actions="true"');

    expect(inlineButtonIndex).toBeGreaterThan(tabListEndIndex);
    expect(inlineButtonIndex).toBeLessThan(scrollEndIndex);
    expect(actionsIndex).toBe(-1);
    expect(tabBarSource).toContain('class="relative flex h-full w-8 shrink-0');
    expect(tabBarSource).toContain("onClick={() => openNewTabPlaceholder()}");
    expect(tabBarSource).not.toContain("createAndOpenNewFile");

    const inlineButtonSource = tabBarSource.slice(
      inlineButtonIndex,
      tabBarSource.indexOf("</button>", inlineButtonIndex),
    );
    expect(inlineButtonSource).not.toContain("border-r border-border");
    expect(tabBarSource).not.toContain('data-kuku-tabbar-actions="true"');
  });

  it("renders the placeholder tab through the empty center view", () => {
    const centerPanelSource = readSource("components/layout/center_panel.tsx");

    expect(centerPanelSource).toContain('activeTab()?.type === "placeholder"');
    expect(centerPanelSource).toContain("const showEmptyState = () =>");
  });

  it("does not draw a bottom divider on the title bar", () => {
    const titleBarSource = readSource("components/layout/title_bar.tsx");

    expect(titleBarSource).not.toContain("border-b border-border");
  });

  it("draws a tab bar bottom divider while masking it under the active tab", () => {
    const titleBarSource = readSource("components/layout/title_bar.tsx");
    const tabBarSource = readSource("components/layout/tab_bar.tsx");
    const rightPanelTabBarSource = readSource("components/layout/right_panel_tab_bar.tsx");

    expect(tabBarSource).toContain('data-kuku-tabbar-bottom-divider="true"');
    expect(tabBarSource).toContain("absolute inset-x-0 bottom-0 z-0 h-px bg-border");
    expect(tabBarSource).toContain('data-kuku-tab-bottom-divider="true"');
    expect(tabBarSource).toContain("absolute inset-x-0 bottom-0 h-px bg-border");
    expect(tabBarSource).toContain('data-kuku-active-tab-divider-mask="true"');
    expect(tabBarSource).toContain("absolute inset-x-0 bottom-0 h-px bg-bg-primary");

    const inlineButtonIndex = tabBarSource.indexOf('data-kuku-inline-new-tab-button="true"');
    const inlineButtonSource = tabBarSource.slice(
      inlineButtonIndex,
      tabBarSource.indexOf("</button>", inlineButtonIndex),
    );
    expect(inlineButtonSource).toContain('data-kuku-tab-bottom-divider="true"');
    expect(inlineButtonSource).toContain("absolute inset-x-0 bottom-0 h-px bg-border");

    expect(tabBarSource).not.toContain('data-kuku-tabbar-actions-bottom-divider="true"');

    const leftHitAreaIndex = titleBarSource.indexOf('data-kuku-titlebar-left-hit-area="true"');
    const leftHitAreaStartIndex = titleBarSource.lastIndexOf("<div", leftHitAreaIndex);
    const leftHitAreaSource = titleBarSource.slice(
      leftHitAreaStartIndex,
      titleBarSource.indexOf("{/* ── Right region ── */}", leftHitAreaIndex),
    );
    expect(leftHitAreaSource).toContain('data-kuku-titlebar-left-bottom-divider="true"');
    expect(leftHitAreaSource).toContain("absolute inset-x-0 bottom-0 h-px bg-border");
    expect(leftHitAreaSource).toContain('classList={{ hidden: layoutState.leftPanelOpen }}');

    const rightHitAreaIndex = titleBarSource.indexOf(
      'data-kuku-titlebar-right-hit-area="true"',
    );
    const rightHitAreaStartIndex = titleBarSource.lastIndexOf("<div", rightHitAreaIndex);
    const rightHitAreaSource = titleBarSource.slice(
      rightHitAreaStartIndex,
      titleBarSource.indexOf("</header>", rightHitAreaIndex),
    );
    expect(rightHitAreaSource).toContain('data-kuku-titlebar-right-bottom-divider="true"');
    expect(rightHitAreaSource).toContain("absolute inset-x-0 bottom-0 h-px bg-border");
    expect(rightHitAreaSource).not.toContain("min-w-18");
    expect(rightHitAreaSource).toContain("justify-end");
    expect(rightPanelTabBarSource).toContain('data-kuku-right-buttonbar-bottom-divider="true"');
    expect(rightPanelTabBarSource).toContain("absolute inset-x-0 bottom-0 z-0 h-px bg-border");
    expect(rightPanelTabBarSource).not.toContain('data-kuku-right-tab-bottom-divider="true"');
    expect(rightPanelTabBarSource).not.toContain('data-kuku-active-right-tab-divider-mask="true"');
    expect(rightPanelTabBarSource).not.toContain("border-r border-border");
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
