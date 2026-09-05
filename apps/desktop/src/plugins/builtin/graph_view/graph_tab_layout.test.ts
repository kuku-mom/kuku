/// <reference types="node" />

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
    expect(source).toContain('data-kuku-graph-legend-item="true"');
    expect(source).toContain('data-kuku-graph-legend-active-indicator="true"');
    expect(source).toContain(
      'class="flex size-4 shrink-0 items-center justify-center text-text-primary"',
    );
    expect(source).toContain("CheckIcon");
    expect(source).toContain("ListIcon");
    expect(source).toContain("selectedLegendClusterIndexes");
    expect(source).toContain("toggleLegendCluster");
    expect(source).toContain("isLegendClusterSelected");
    expect(source).toContain("legendNodeFilter");
    expect(source).toContain("selected.size === 0");
    expect(source).toContain("selected.has(node.clusterIndex)");
    expect(source).toContain("nodeFilter={legendNodeFilter()}");
    expect(source).toContain("preserveFilteredClusterColors");
    expect(source).toContain("legendButtonEl");
    expect(source).toContain("legendPopoverEl");
    expect(source).toContain("handleLegendOutsidePointerDown");
    expect(source).toContain('"bg-element-selected text-text-primary": legendOpen()');
    expect(source).toContain(
      'document.addEventListener("pointerdown", handleLegendOutsidePointerDown, true)',
    );
    expect(source).toContain(
      'document.removeEventListener("pointerdown", handleLegendOutsidePointerDown, true)',
    );
    expect(source).toContain("legendButtonEl?.contains(target)");
    expect(source).toContain("legendPopoverEl?.contains(target)");
    expect(source).toContain("setLegendOpen(false)");
    expect(source).toContain('"bg-element-selected text-text-primary": isLegendClusterSelected(');
    expect(source).toContain("aria-pressed={isLegendClusterSelected(i())}");
    expect(source).toContain('isLegendClusterSelected(i()) ? "true" : "false"');
    expect(source).toContain('data-kuku-scrollbar-hidden="true"');
    expect(source).toContain("absolute top-3 right-3 z-30 flex w-10 flex-col items-center gap-1");
    expect(source).toContain("absolute top-3 right-16 z-20 flex max-h-[min(70vh,28rem)] w-64");
    expect(source).toContain("bg-bg-elevated/85 p-1 shadow-soft-2 backdrop-blur-sm");
    expect(source).toContain("size-8");
    expect(source).toContain("text-[0.625rem]");
    expect(source).not.toContain("import { ClustersIcon }");
    expect(source).toContain("SettingsIcon");
    expect(source).toContain('<GraphSettingsPanel mode="3d"');
    expect(source).toContain("settingsOpen");
    expect(source).not.toContain(
      '"bg-element-selected text-text-primary shadow-soft-1": legendOpen()',
    );
    expect(source).not.toContain(
      '"bg-element-selected text-text-primary shadow-soft-1": isLegendClusterSelected(',
    );
    expect(source).not.toContain("rounded-full bg-element-active");
    expect(source).not.toContain("ring-1 ring-border-selected");
    expect(source).not.toContain("setSelectedLegendClusterIndex(");
    expect(source).not.toContain("selectedLegendClusterIndex()");
    expect(source).not.toContain("createSignal<number | null>");
    expect(source).toContain("kuku-constellation-legend");
    expect(source).not.toContain("bg-bg-primary/75");
    expect(source).not.toContain(
      "overflow-hidden border-t border-border/70 bg-bg-secondary/40 px-4 py-2",
    );
    expect(source).not.toContain("legendRef");
    expect(source).not.toContain("visibleCount");
    expect(source).not.toContain("graph.tab.metric.");
    expect(source).not.toContain('t("graph.tab.subtitle")');
  });

  it("defines the hidden scrollbar utility used by the legend list", () => {
    const source = readFileSync(scrollbarSourcePath, "utf8");

    expect(source).toContain('[data-kuku-scrollbar-hidden="true"]');
    expect(source).toContain("scrollbar-width: none");
    expect(source).toContain('[data-kuku-scrollbar-hidden="true"]::-webkit-scrollbar');
    expect(source).toContain("display: none");
  });
});
