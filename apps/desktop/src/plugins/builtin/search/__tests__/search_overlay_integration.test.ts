import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

function readSource(relativePath: string): string {
  return readFileSync(resolve(sourceRoot, relativePath), "utf8");
}

describe("search overlay integration", () => {
  it("routes advanced search entry points into the omnibar advanced mode", () => {
    const searchPluginSource = readSource("plugins/builtin/search/index.ts");
    const centerPanelSource = readSource("components/layout/center_panel.tsx");
    const omnibarSource = readSource("plugins/builtin/search/omnibar.tsx");

    expect(searchPluginSource).toContain('execute: () => openSearchOmnibar("regex")');
    expect(searchPluginSource).not.toContain('openTab("Advanced Search", null, "search")');
    expect(centerPanelSource).toContain('openSearchOmnibar("regex")');
    expect(centerPanelSource).not.toContain('openTab(t("center.empty.advanced_search"), null, "search")');

    expect(omnibarSource).toContain('data-kuku-search-mode-toggle="true"');
    expect(omnibarSource).toContain('data-kuku-search-case-sensitive-toggle="true"');
    expect(omnibarSource).toContain('t("search.mode.advanced")');
  });
});
