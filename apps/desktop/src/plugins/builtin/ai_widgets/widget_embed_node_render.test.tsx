import { renderToString } from "solid-js/web";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SolidNodeViewProps } from "prosekit/solid";

import type { WidgetEmbedNode as WidgetEmbedNodeType } from "./widget_embed_node";

const readWidgetProject = vi.hoisted(() => vi.fn());

vi.mock("./project_store", () => ({
  createWidgetProjectStore: () => ({
    read: readWidgetProject,
  }),
}));

let WidgetEmbedNode: typeof WidgetEmbedNodeType;

beforeAll(async () => {
  ({ WidgetEmbedNode } = await import("./widget_embed_node"));
});

beforeEach(() => {
  readWidgetProject.mockReset();
  readWidgetProject.mockResolvedValue(null);
});

describe("WidgetEmbedNode", () => {
  it("renders widget content without a title bar", () => {
    const html = renderWidgetEmbed();

    expect(html).toContain("data-kuku-widget-node");
    expect(html).toContain("data-kuku-widget-resize-handle");
    expect(html).not.toContain("justify-between border-b border-border/60");
  });

  it("shows read-only source without vertical padding when the widget node is selected", () => {
    const html = renderWidgetEmbed({ selected: true });

    expect(html).toContain("<pre");
    expect(html).toContain("<code");
    expect(html).toContain("data-kuku-widget-source");
    expect(html).toContain("```kuku-widget");
    expect(html).toContain("id: daily-trends");
    expect(html).toContain("height: 360");
    expect(html).toContain("data-kuku-widget-source-code");
    expect(html).toContain("p-0!");
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain("data-kuku-widget-resize-handle");
    expect(html).not.toContain("h-3");
    expect(html).not.toContain("my-0");
    expect(html).not.toContain("my-4");
    expect(html).not.toContain("px-3");
    expect(html).not.toContain("py-2");
    expect(html).not.toContain("py-0");
  });

  it("does not show loading for an empty widget id", () => {
    const html = renderWidgetEmbed({
      node: { attrs: { id: "", height: 360 } } as unknown as SolidNodeViewProps["node"],
    });

    expect(html).not.toContain("Loading widget...");
    expect(html).toContain("Widget not found");
  });
});

function renderWidgetEmbed(overrides: Partial<SolidNodeViewProps> = {}): string {
  return renderToString(() => (
    <WidgetEmbedNode
      {...({
        node: { attrs: { id: "daily-trends", height: 360 } },
        selected: false,
        setAttrs: vi.fn(),
        ...overrides,
      } as unknown as SolidNodeViewProps)}
    />
  ));
}
