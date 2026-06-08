import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const sourcePath = resolve(__dirname, "graph_tab.tsx");
const scrollbarSourcePath = resolve(__dirname, "../../../styles/scrollbar.css");

function graphTabSource(): string {
  return readFileSync(sourcePath, "utf8");
}

describe("GraphTab layout", () => {
  it("keeps graph view controls inside the canvas instead of the header", () => {
    const source = graphTabSource();

    expect(source).toContain('data-kuku-graph-view-controls="true"');
    expect(source).toContain('data-kuku-graph-legend-popover="true"');
    expect(source).toContain('data-kuku-graph-legend-list="true"');
    expect(source).toContain("ListIcon");
    expect(source).toContain("selectedLegendClusterIndex");
    expect(source).toContain("legendNodeFilter");
    expect(source).toContain("nodeFilter={legendNodeFilter()}");
    expect(source).toContain("preserveFilteredClusterColors");
    expect(source).toContain('aria-pressed={selectedLegendClusterIndex() === i()}');
    expect(source).toContain("kuku-scrollbar-hidden");
    expect(source).toContain("absolute top-3 right-3 z-30 flex w-10 flex-col items-center gap-1");
    expect(source).toContain("absolute top-3 right-16 z-20 flex max-h-[min(70vh,28rem)] w-64");
    expect(source).toContain("bg-bg-elevated/85 p-1 shadow-soft-2 backdrop-blur-sm");
    expect(source).toContain("size-8 text-[0.625rem]");
    expect(source).not.toContain("import { ClustersIcon }");
    expect(source).not.toContain("SettingsIcon");
    expect(source).not.toContain("GraphSettingsPanel");
    expect(source).not.toContain("settingsOpen");
    expect(source).not.toContain("settings.plugin.graph_view.title");
    expect(source).not.toContain("bg-bg-primary/75");
    expect(source).not.toContain("overflow-hidden border-t border-border/70 bg-bg-secondary/40 px-4 py-2");
    expect(source).not.toContain("legendRef");
    expect(source).not.toContain("visibleCount");
    expect(source).not.toContain("graph.tab.metric.");
    expect(source).not.toContain('t("graph.tab.subtitle")');
  });

  it("defines the hidden scrollbar utility used by the legend list", () => {
    const source = readFileSync(scrollbarSourcePath, "utf8");

    expect(source).toContain(".kuku-scrollbar-hidden");
    expect(source).toContain("scrollbar-width: none");
    expect(source).toContain(".kuku-scrollbar-hidden::-webkit-scrollbar");
    expect(source).toContain("display: none");
  });
});
