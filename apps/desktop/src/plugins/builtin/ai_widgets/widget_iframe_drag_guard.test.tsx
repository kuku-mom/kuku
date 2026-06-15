import { renderToString } from "solid-js/web";
import { describe, expect, it } from "vitest";

import { serializeWidgetArtifactOutput } from "./artifact";
import type { WidgetArtifactEnvelope } from "./types";
import { WidgetArtifactPreview } from "./widget_preview";
import {
  WIDGET_IFRAME_DRAG_GUARD_ATTR,
  widgetIframeDragGuardAttrs,
} from "./widget_iframe_drag_guard";

describe("widget iframe drag guard", () => {
  it("uses a stable attribute for layout resize iframe guards", () => {
    expect(WIDGET_IFRAME_DRAG_GUARD_ATTR).toBe("data-kuku-widget-iframe");
    expect(widgetIframeDragGuardAttrs()).toEqual({
      "data-kuku-widget-iframe": "",
    });
  });

  it("marks widget artifact preview iframes as guarded", () => {
    const html = renderToString(() => (
      <WidgetArtifactPreview output={serializeWidgetArtifactOutput(createWidgetArtifact())} />
    ));

    expect(html).toContain("data-kuku-widget-iframe");
  });
});

function createWidgetArtifact(): WidgetArtifactEnvelope {
  return {
    kind: "kuku.widget-artifact",
    version: 1,
    projectPath: ".kuku/plugins/ai-widgets/projects/seoul-clock",
    markdownEmbed: "```kuku-widget\nid: seoul-clock\nheight: 320\n```",
    widget: {
      id: "seoul-clock",
      name: "Seoul Clock",
      type: "html",
      entry: "index.html",
      files: [{ path: "index.html", content: "<h1>Seoul</h1>" }],
      createdAt: "2026-06-10T00:00:00.000Z",
      updatedAt: "2026-06-10T00:00:00.000Z",
    },
  };
}
