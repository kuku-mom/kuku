import { renderToString } from "solid-js/web";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { SolidNodeViewProps } from "prosekit/solid";

import type { WidgetEmbedNode as WidgetEmbedNodeType } from "./widget_embed_node";

vi.mock("./project_store", () => ({
  createWidgetProjectStore: () => ({
    read: vi.fn().mockResolvedValue(null),
  }),
}));

let WidgetEmbedNode: typeof WidgetEmbedNodeType;

beforeAll(async () => {
  ({ WidgetEmbedNode } = await import("./widget_embed_node"));
});

describe("WidgetEmbedNode", () => {
  it("renders widget content without a title bar", () => {
    const html = renderWidgetEmbed();

    expect(html).toContain("data-kuku-widget-node");
    expect(html).toContain("data-kuku-widget-resize-handle");
    expect(html).not.toContain("justify-between border-b border-border/60");
  });

  it("shows editable source without vertical padding when the widget node is selected", () => {
    const html = renderWidgetEmbed({ selected: true });

    expect(html).toContain("<textarea");
    expect(html).toContain("data-kuku-widget-source");
    expect(html).toContain("```kuku-widget");
    expect(html).toContain("id: daily-trends");
    expect(html).toContain("height: 360");
    expect(html).not.toContain("<pre");
    expect(html).not.toContain("my-4");
    expect(html).not.toContain("py-2");
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
