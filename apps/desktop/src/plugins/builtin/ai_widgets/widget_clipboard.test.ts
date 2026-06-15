import { describe, expect, it, vi } from "vitest";

import { buildWidgetClipboardHtml, writeWidgetEmbedToClipboard } from "./widget_clipboard";

class MockClipboardItem {
  readonly items: Record<string, Blob>;

  constructor(items: Record<string, Blob>) {
    this.items = items;
  }
}

describe("widget clipboard", () => {
  it("builds html that pastes as a kuku-widget code block", () => {
    expect(buildWidgetClipboardHtml("seoul-clock", 360)).toBe(
      '<pre data-language="kuku-widget"><code>id: seoul-clock\nheight: 360</code></pre>',
    );
  });

  it("writes markdown and html clipboard formats", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("ClipboardItem", MockClipboardItem);

    await writeWidgetEmbedToClipboard("seoul-clock", 360, { write, writeText });

    expect(writeText).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledOnce();
    const item = write.mock.calls[0]?.[0]?.[0] as { items: Record<string, Blob> };
    expect(await item.items["text/plain"]?.text()).toBe(
      "```kuku-widget\nid: seoul-clock\nheight: 360\n```",
    );
    expect(await item.items["text/html"]?.text()).toContain('data-language="kuku-widget"');
  });

  it("falls back to plain text when html clipboard writes fail", async () => {
    const write = vi.fn().mockRejectedValue(new Error("no html clipboard"));
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("ClipboardItem", MockClipboardItem);

    await writeWidgetEmbedToClipboard("seoul-clock", 360, { write, writeText });

    expect(writeText).toHaveBeenCalledWith("```kuku-widget\nid: seoul-clock\nheight: 360\n```");
  });
});
