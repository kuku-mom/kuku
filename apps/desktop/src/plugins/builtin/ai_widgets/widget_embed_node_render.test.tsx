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
    const html = renderToString(() => (
      <WidgetEmbedNode
        {...({
          node: { attrs: { id: "daily-trends", height: 360 } },
          setAttrs: vi.fn(),
        } as unknown as SolidNodeViewProps)}
      />
    ));

    expect(html).toContain("data-kuku-widget-node");
    expect(html).toContain("data-kuku-widget-resize-handle");
    expect(html).not.toContain("justify-between border-b border-border/60");
  });
});
