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

    expect(titleBarSource).toContain('class="flex h-full min-w-0 flex-1 items-stretch"');
    expect(titleBarSource).not.toContain("absolute inset-x-0");
  });
});
