import { buildWidgetMarkdownEmbed } from "./artifact";

function buildWidgetClipboardHtml(widgetId: string, height = 320): string {
  return `<pre data-language="kuku-widget"><code>${escapeHtml(`id: ${widgetId}\nheight: ${height}`)}</code></pre>`;
}

async function writeWidgetEmbedToClipboard(
  widgetId: string,
  height = 320,
  clipboard: Pick<Clipboard, "write" | "writeText"> = navigator.clipboard,
): Promise<void> {
  const markdown = buildWidgetMarkdownEmbed(widgetId, height);
  if (typeof ClipboardItem === "function") {
    try {
      await clipboard.write([
        new ClipboardItem({
          "text/plain": new Blob([markdown], { type: "text/plain" }),
          "text/html": new Blob([buildWidgetClipboardHtml(widgetId, height)], {
            type: "text/html",
          }),
        }),
      ]);
      return;
    } catch {
      // Fall back for WebViews that expose ClipboardItem but reject rich clipboard writes.
    }
  }
  await clipboard.writeText(markdown);
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export { buildWidgetClipboardHtml, writeWidgetEmbedToClipboard };
