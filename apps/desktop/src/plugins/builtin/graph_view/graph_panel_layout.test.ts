import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const sourcePath = resolve(__dirname, "graph_panel.tsx");

function graphPanelSource(): string {
  return readFileSync(sourcePath, "utf8");
}

describe("GraphPanel layout", () => {
  it("keeps compact graph view controls inside the canvas without a title header", () => {
    const source = graphPanelSource();

    expect(source).toContain('data-kuku-graph-panel-controls="true"');
    expect(source).toContain("absolute top-2 right-2 z-30 flex w-7 flex-col items-center gap-0");
    expect(source).toContain("size-6 cursor-pointer");
    expect(source).toContain("text-[0.5625rem]");
    expect(source).toContain("OpenInTabIcon");
    expect(source).toContain("openGraphInCenterTab");
    expect(source).toContain('t("graph.action.open_center_title")');
    expect(source).toContain('t("graph.action.open_in_tab")');
    expect(source).not.toContain("SettingsIcon");
    expect(source).not.toContain("GraphSettingsPanel");
    expect(source).not.toContain("settingsOpen");
    expect(source).not.toContain("settings.plugin.graph_view.title");
    expect(source).not.toContain('t("graph.title")');
    expect(source).not.toContain("border-b border-border/70 bg-bg-primary/50");
  });
});
